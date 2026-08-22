import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { EngineManager } from "../src/engine/index.js";
import { createWorldHost } from "../src/world/bridge.js";
import type { DeterministicShellOptions } from "../src/world/deterministic-shell.js";
import { makePrincipalId, type WorldOperation } from "../src/world/domain.js";
import { makeWorldRuntime, type WorldRuntime } from "../src/world/runtime.js";
import type { AuthorityService } from "../src/world/services.js";
import {
	DEFAULT_VIRTUAL_PROFILES,
	makeFileShellAudit,
	makeGrantEnforcedTracer,
	makeProfileRegistry,
	makeShellGrants,
	VIRTUAL_TRACER_PROFILE,
} from "../src/world/shell-authority.js";
import { makeDeterministicAgents, makeDeterministicWeb } from "../src/world/test-adapters.js";

const engines: EngineManager[] = [];
const runtimes: WorldRuntime[] = [];
const tempDirs: string[] = [];

const tempDir = () => {
	const path = mkdtempSync(join(tmpdir(), "pi-world-bridge-"));
	tempDirs.push(path);
	return path;
};

const harness = (
	options: {
		depth?: number;
		maxDepth?: number;
		snapshot?: string;
		waitDelayMs?: number;
		allowedOperations?: readonly WorldOperation[];
		authority?: AuthorityService;
		shellOptions?: DeterministicShellOptions;
	} = {},
) => {
	const agents = makeDeterministicAgents({
		outputs: { alpha: "A", beta: "B", gamma: "C", slow: "finished" },
		waitDelayMs: options.waitDelayMs,
	});
	const web = makeDeterministicWeb();
	// The bridge harness runs the same governed tracer stack as production:
	// host-issued root grant, durable audit, and grant-enforced admissions.
	const grants = makeShellGrants({ registry: makeProfileRegistry(DEFAULT_VIRTUAL_PROFILES) });
	const principalId = makePrincipalId("principal-session-bridge");
	grants.issueRoot({ principalId, sessionId: "session-bridge", depth: options.depth ?? 0, lineage: [] });
	const governed = makeGrantEnforcedTracer({
		grants,
		audit: makeFileShellAudit({ path: join(tempDir(), "shell-audit.jsonl") }),
		profile: VIRTUAL_TRACER_PROFILE,
		tracerOptions: options.shellOptions,
	});
	const runtime = makeWorldRuntime({
		agents: agents.service,
		web: web.service,
		shell: governed.service,
		grants,
		maxDepth: options.maxDepth,
		allowedOperations: options.allowedOperations,
		authority: options.authority,
	});
	runtimes.push(runtime);
	const host = createWorldHost({
		runtime,
		sessionId: "session-bridge",
		depth: options.depth ?? 0,
		principalId: makePrincipalId("principal-session-bridge"),
	});
	const engine = new EngineManager({
		hostHandlers: host.handlers,
		snapshot: options.snapshot ? { path: options.snapshot, debounceMs: 600_000 } : undefined,
	});
	engines.push(engine);
	return { engine, agents, web, governed, grants, principalId, handlers: host.handlers };
};

afterEach(async () => {
	await Promise.allSettled(engines.splice(0).map((engine) => engine.kill()));
	await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("World evaluator bridge", () => {
	test("guest traces one Virtual Shell execution through host identity, runtime, and deterministic adapter", async () => {
		const subjectFields = {
			sessionId: "session-bridge",
			cellId: "shell-cell",
			depth: 1,
			principalId: makePrincipalId("principal-session-bridge"),
		};
		const authorized: Array<{
			operation: WorldOperation;
			sessionId: string;
			cellId?: string;
			depth: number;
			principalId: unknown;
		}> = [];
		const authority: AuthorityService = {
			check: (subject, operation) =>
				Effect.sync(() => {
					authorized.push({ operation, ...subject });
				}),
		};
		const { engine, governed, agents, web } = harness({ authority, depth: 1 });
		const result = await engine.execute(
			[
				'const shellExecution = await world.shell.virtual.exec({ script: "echo tracer" });',
				"let durableShellExecutionId = shellExecution.executionId;",
				'const worker = await world.agents.spawn("alpha");',
				'const [terminal, agent, search] = await Promise.all([shellExecution.wait(), worker.wait(), world.web.search("Effect bridge")]);',
				"({ sameId: shellExecution.id === shellExecution.executionId, cancel: typeof shellExecution.cancel, sameTerminalId: terminal.executionId === shellExecution.executionId, profile: terminal.profileId, status: terminal.status._tag, agent: agent.output, search: search.text })",
			].join("\n"),
			{ cellId: "shell-cell" },
		);
		expect(result.status).toBe("ok");
		expect(result.result).toContain("sameId: true");
		expect(result.result).toContain('cancel: "function"');
		expect(result.result).toContain("sameTerminalId: true");
		expect(result.result).toContain('profile: "virtual-tracer-v1"');
		expect(result.result).toContain('status: "exited"');
		expect(result.result).toContain("A");
		expect(result.result).toContain("result: Effect bridge");
		expect(governed.events.map((event) => event._tag)).toEqual(["admitted", "settled", "waited"]);
		expect(agents.events.map((event) => event._tag)).toEqual(["spawned", "waited"]);
		expect(web.queries).toEqual(["Effect bridge"]);
		expect(authorized).toEqual([
			{ operation: "shell.virtual.exec", ...subjectFields },
			{ operation: "agents.spawn", ...subjectFields },
			{ operation: "shell.wait", ...subjectFields },
			{ operation: "agents.wait", ...subjectFields },
			{ operation: "web.search", ...subjectFields },
		]);
	});

	test("malformed and denied Virtual Shell requests fail before adapter admission", async () => {
		const malformedHarness = harness();
		const malformed = await malformedHarness.engine.execute(
			"let shellError; try { await world.shell.virtual.exec({ script: 42, sessionId: 'forged' }); } catch (error) { shellError = { code: error.code, operation: error.operation, message: error.message }; } shellError",
		);
		expect(malformed.status).toBe("ok");
		expect(malformed.result).toContain("SHELL_INVALID_REQUEST");
		expect(malformed.result).toContain("shell.virtual.exec");
		expect(malformed.result).not.toContain("ParseError");
		expect(malformedHarness.governed.events).toHaveLength(0);

		const deniedHarness = harness({
			allowedOperations: ["agents.spawn", "agents.wait", "agents.cancel", "web.search"],
		});
		const denied = await deniedHarness.engine.execute(
			"let shellError; try { await world.shell.virtual.exec({ script: 'denied' }); } catch (error) { shellError = { code: error.code, operation: error.operation }; } shellError",
		);
		expect(denied.status).toBe("ok");
		expect(denied.result).toContain("SHELL_AUTHORITY_DENIED");
		expect(denied.result).toContain("shell.virtual.exec");
		expect(deniedHarness.governed.events).toHaveLength(0);
	});

	test("guest code fans out ergonomic handles and waits without a status or list API", async () => {
		const { engine, agents, web } = harness();
		const result = await engine.execute(
			'const workers = await world.agents.spawnMany(["alpha", "beta", "gamma"]);\n' +
				"const shape = workers.map((worker) => [worker.id === worker.agentId, typeof worker.wait, typeof worker.cancel]);\n" +
				"const results = await Promise.all(workers.map((worker) => worker.wait()));\n" +
				'const search = await world.web.search("Effect bridge");\n' +
				"({ shape, outputs: results.map((entry) => entry.output), search: search.text, list: world.agents.list })",
		);

		expect(result.status).toBe("ok");
		expect(result.result).toContain("A");
		expect(result.result).toContain("B");
		expect(result.result).toContain("C");
		expect(result.result).toContain("result: Effect bridge");
		expect(result.result).toContain("undefined");
		expect(agents.events.map((event) => event._tag)).toEqual([
			"spawned",
			"spawned",
			"spawned",
			"waited",
			"waited",
			"waited",
		]);
		expect(web.queries).toEqual(["Effect bridge"]);
	});

	test("schema and authority failures cross as small structured errors", async () => {
		const invalidHarness = harness();
		const invalid = await invalidHarness.engine.execute(
			"let caught; try { await world.agents.spawn({ task: 42 }); } catch (error) { caught = { code: error.code, tag: error._tag, message: error.message }; } caught",
		);
		expect(invalid.status).toBe("ok");
		expect(invalid.result).toContain("WORLD_INVALID_REQUEST");
		expect(invalid.result).toContain("WorldInvalidRequest");
		expect(invalid.result).not.toContain("ParseError");

		const deniedHarness = harness({ depth: 1, maxDepth: 1 });
		const denied = await deniedHarness.engine.execute(
			'let caught; try { await world.agents.spawn({ task: "too deep" }); } catch (error) { caught = { code: error.code, operation: error.operation }; } caught',
		);
		expect(denied.status).toBe("ok");
		expect(denied.result).toContain("WORLD_ACCESS_DENIED");
		expect(denied.result).toContain("agents.spawn");
		expect(deniedHarness.agents.events).toHaveLength(0);
	});

	test("handle wait timeout and cancellation preserve their distinct semantics", async () => {
		const { engine } = harness({ waitDelayMs: 100 });
		const admission = await engine.execute('const slow = await world.agents.spawn("slow"); slow.id');
		expect(admission.status).toBe("ok");
		const result = await engine.execute(
			"let timeoutCode; try { await slow.wait({ timeoutMs: 10 }); } catch (error) { timeoutCode = error.code; }\n" +
				"const finished = await slow.wait();\n" +
				'const stopped = await world.agents.spawn("cancel me"); await stopped.cancel(); const cancelled = await stopped.wait();\n' +
				"({ timeoutCode, finished: finished.output, cancelled: cancelled._tag })",
		);
		expect(result.status).toBe("ok");
		expect(result.result).toContain("AGENT_WAIT_TIMEOUT");
		expect(result.result).toContain("finished");
		expect(result.result).toContain("cancelled");
	});

	test("world and ergonomic handles are live-only while plain IDs and state restore", async () => {
		const snapshot = join(tempDir(), "namespace.snapshot");
		const first = harness({ snapshot });
		const admitted = await first.engine.execute(
			'const worker = await world.agents.spawn("alpha"); const shellExecution = await world.shell.virtual.exec({ script: "snapshot tracer" }); let durableAgentId = worker.agentId; let durableShellExecutionId = shellExecution.executionId; let plain = { n: 7 };',
		);
		expect(admitted.status).toBe("ok");
		const saved = await first.engine.snapshotState();
		expect(saved?.saved).toEqual(expect.arrayContaining(["durableAgentId", "durableShellExecutionId", "plain"]));
		expect(saved?.saved).not.toContain("world");
		expect(saved?.failed.map((entry) => entry.name)).toEqual(expect.arrayContaining(["worker", "shellExecution"]));
		await first.engine.kill();

		const secondEngine = new EngineManager({
			hostHandlers: first.handlers,
			snapshot: { path: snapshot, debounceMs: 600_000 },
		});
		engines.push(secondEngine);
		await secondEngine.start();
		const restored = await secondEngine.restoreState();
		expect(restored?.restored).toEqual(expect.arrayContaining(["durableAgentId", "durableShellExecutionId", "plain"]));
		expect(restored?.restored).not.toEqual(expect.arrayContaining(["worker", "shellExecution"]));
		// The durable ID crosses the snapshot; the live handle does not. Exact-ID
		// attach reconstitutes the handle in the new generation.
		const live = await secondEngine.execute(
			'const probe = await world.web.search("after restart"); const recovered = await world.shell.attach({ executionId: durableShellExecutionId }); const nextShell = await world.shell.virtual.exec({ script: "after restart" }); String(plain.n) + ":" + (await recovered.wait()).mode + ":" + (await nextShell.wait()).mode + ":" + typeof world.shell.wait + ":" + probe.text',
		);
		expect(live.result).toContain("7:virtual:virtual:function:result: after restart");
	});

	test("a timed-out wait withdraws observation and a later wait converges on the terminal result", async () => {
		const { engine } = harness({ shellOptions: { executionMs: 120 } });
		const admission = await engine.execute(
			'const execution = await world.shell.virtual.exec({ script: "slow tracer" }); execution.executionId',
		);
		expect(admission.status).toBe("ok");
		const result = await engine.execute(
			"let timeoutCode; try { await execution.wait({ timeoutMs: 15 }); } catch (error) { timeoutCode = error.code; }\n" +
				"const terminal = await execution.wait();\n" +
				"({ timeoutCode, status: terminal.status._tag, started: terminal.started, id: terminal.executionId === execution.executionId })",
		);
		expect(result.status).toBe("ok");
		expect(result.result).toContain('timeoutCode: "SHELL_WAIT_TIMEOUT"');
		expect(result.result).toContain('status: "exited"');
		expect(result.result).toContain("id: true");
	});

	test("awaited repeated cancellations and waits converge on the identical retained record", async () => {
		const { engine } = harness({ shellOptions: { executionMs: 120 } });
		await engine.execute(
			'const execution = await world.shell.virtual.exec({ script: "cancel tracer" }); execution.executionId',
		);
		const result = await engine.execute(
			"await execution.cancel();\n" +
				"await execution.cancel();\n" +
				"const first = await execution.wait();\n" +
				"const second = await execution.wait();\n" +
				"const viaWorld = await world.shell.wait({ executionId: execution.executionId });\n" +
				"({ branch: first.status._tag, reason: first.status.reason, identical: JSON.stringify(first) === JSON.stringify(second) && JSON.stringify(first) === JSON.stringify(viaWorld) })",
		);
		expect(result.status).toBe("ok");
		expect(result.result).toContain('branch: "cancelled"');
		expect(result.result).toContain('reason: "caller"');
		expect(result.result).toContain("identical: true");
	});

	test("unknown IDs fail identically across wait, cancel, and attach", async () => {
		const { engine } = harness();
		const result = await engine.execute(
			"const probes = {};\n" +
				'for (const operation of ["wait", "cancel", "attach"]) {\n' +
				"	let first, second;\n" +
				'	try { await world.shell[operation]({ executionId: "unknown-one" }); } catch (error) { first = [error.code, error.message, error.operation]; }\n' +
				'	try { await world.shell[operation]({ executionId: "unknown-two" }); } catch (error) { second = [error.code, error.message, error.operation]; }\n' +
				"	probes[operation] = JSON.stringify(first) === JSON.stringify(second) ? first.join('|') : 'MISMATCH';\n" +
				"}\n" +
				"probes",
		);
		expect(result.status).toBe("ok");
		expect(result.result).toContain('wait: "SHELL_EXECUTION_NOT_FOUND|shell execution was not found|shell.wait"');
		expect(result.result).toContain('cancel: "SHELL_EXECUTION_NOT_FOUND|shell execution was not found|shell.cancel"');
		expect(result.result).toContain('attach: "SHELL_EXECUTION_NOT_FOUND|shell execution was not found|shell.attach"');
	});

	test("expired executions become indistinguishable from unknown ones after their retention window", async () => {
		const { engine } = harness({ shellOptions: { expireAfterMs: 40 } });
		const result = await engine.execute(
			'const execution = await world.shell.virtual.exec({ script: "expires" });\n' +
				"const settled = await execution.wait();\n" +
				"await new Promise((resolve) => setTimeout(resolve, 80));\n" +
				"let expiredWait, expiredAttach;\n" +
				"try { await world.shell.wait({ executionId: execution.executionId }); } catch (error) { expiredWait = error.code; }\n" +
				"try { await world.shell.attach({ executionId: execution.executionId }); } catch (error) { expiredAttach = error.code; }\n" +
				"({ settled: settled.status._tag, expiredWait, expiredAttach })",
		);
		expect(result.status).toBe("ok");
		expect(result.result).toContain('settled: "exited"');
		expect(result.result).toContain('expiredWait: "SHELL_EXECUTION_NOT_FOUND"');
		expect(result.result).toContain('expiredAttach: "SHELL_EXECUTION_NOT_FOUND"');
	});

	test("guest-supplied authority fields never establish authority", async () => {
		const { engine } = harness();
		const spawnForge = await engine.execute(
			'let caught; try { await world.agents.spawn({ task: "x", principalId: "forged-principal", grantId: "forged-grant" }); } catch (error) { caught = { code: error.code }; } caught',
		);
		expect(spawnForge.status).toBe("ok");
		expect(spawnForge.result).toContain("WORLD_INVALID_REQUEST");

		const execForge = await engine.execute(
			'let caught; try { await world.shell.virtual.exec({ schemaVersion: 1, script: "x", grantId: "forged-grant" }); } catch (error) { caught = { code: error.code }; } caught',
		);
		expect(execForge.status).toBe("ok");
		expect(execForge.result).toContain("SHELL_INVALID_REQUEST");
	});

	test("a child spawn may request a named profile and the host proves narrowing", async () => {
		const { engine } = harness();
		const admitted = await engine.execute(
			'const child = await world.agents.spawn({ task: "scoped child", shellProfile: "virtual-tracer-v1" }); child.agentId.startsWith("agent-")',
		);
		expect(admitted.status).toBe("ok");
		expect(admitted.result).toContain("true");

		const denied = await engine.execute(
			'let caught; try { await world.agents.spawn({ task: "bad profile", shellProfile: "no-such-profile" }); } catch (error) { caught = { code: error.code, operation: error.operation }; } caught',
		);
		expect(denied.status).toBe("ok");
		expect(denied.result).toContain("WORLD_ACCESS_DENIED");
		expect(denied.result).toContain("agents.spawn");
	});

	test("the shell surface has no list, search, status, or retry API", async () => {
		const { engine } = harness();
		const result = await engine.execute(
			"({ list: world.shell.list, search: world.shell.search, status: world.shell.status, retry: world.shell.retry, exec: typeof world.shell.virtual.exec, wait: typeof world.shell.wait, cancel: typeof world.shell.cancel, attach: typeof world.shell.attach })",
		);
		expect(result.status).toBe("ok");
		expect(result.result).toContain("list: undefined");
		expect(result.result).toContain("search: undefined");
		expect(result.result).toContain("status: undefined");
		expect(result.result).toContain("retry: undefined");
		expect(result.result).toContain('exec: "function"');
		expect(result.result).toContain('wait: "function"');
		expect(result.result).toContain('cancel: "function"');
		expect(result.result).toContain('attach: "function"');
	});

	test("retention erases output before metadata through the public wait", async () => {
		const { engine } = harness({
			shellOptions: {
				outputCharsCap: 100,
				outcome: () => ({ _tag: "exited", exitCode: 0, stdoutBytes: 500 }),
			},
		});
		const result = await engine.execute(
			'const execution = await world.shell.virtual.exec({ script: "big output" });\n' +
				"const first = await execution.wait();\n" +
				"const second = await execution.wait();\n" +
				"({ captured: first.stdout.capturedBytes, total: first.stdout.totalBytes, truncated: first.stdout.truncated, data: first.stdout.data, identical: JSON.stringify(first) === JSON.stringify(second), status: first.status._tag })",
		);
		expect(result.status).toBe("ok");
		expect(result.result).toContain("captured: 0");
		expect(result.result).toContain("total: 500");
		expect(result.result).toContain("truncated: true");
		expect(result.result).toContain('data: ""');
		expect(result.result).toContain("identical: true");
		expect(result.result).toContain('status: "exited"');
	});
});
