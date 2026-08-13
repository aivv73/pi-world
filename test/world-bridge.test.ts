import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager } from "../src/engine/index.js";
import { createWorldHost } from "../src/world/bridge.js";
import { makeWorldRuntime, type WorldRuntime } from "../src/world/runtime.js";
import { makeDeterministicAgents, makeDeterministicWeb } from "../src/world/test-adapters.js";

const engines: EngineManager[] = [];
const runtimes: WorldRuntime[] = [];
const tempDirs: string[] = [];

const tempDir = () => {
	const path = mkdtempSync(join(tmpdir(), "pi-world-bridge-"));
	tempDirs.push(path);
	return path;
};

const harness = (options: { depth?: number; maxDepth?: number; snapshot?: string; waitDelayMs?: number } = {}) => {
	const agents = makeDeterministicAgents({
		outputs: { alpha: "A", beta: "B", gamma: "C", slow: "finished" },
		waitDelayMs: options.waitDelayMs,
	});
	const web = makeDeterministicWeb();
	const runtime = makeWorldRuntime({ agents: agents.service, web: web.service, maxDepth: options.maxDepth });
	runtimes.push(runtime);
	const host = createWorldHost({ runtime, sessionId: "session-bridge", depth: options.depth ?? 0 });
	const engine = new EngineManager({
		hostHandlers: host.handlers,
		snapshot: options.snapshot ? { path: options.snapshot, debounceMs: 600_000 } : undefined,
	});
	engines.push(engine);
	return { engine, agents, web, handlers: host.handlers };
};

afterEach(async () => {
	await Promise.allSettled(engines.splice(0).map((engine) => engine.kill()));
	await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("World evaluator bridge", () => {
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
			'let caught; try { await world.agents.spawn({ task: "too deep", depth: 0, sessionId: "forged" }); } catch (error) { caught = { code: error.code, operation: error.operation }; } caught',
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

	test("world and ergonomic handles are live-only while plain state restores", async () => {
		const snapshot = join(tempDir(), "namespace.snapshot");
		const first = harness({ snapshot });
		const admitted = await first.engine.execute(
			'const worker = await world.agents.spawn("alpha"); let durableAgentId = worker.agentId; let plain = { n: 7 };',
		);
		expect(admitted.status).toBe("ok");
		const saved = await first.engine.snapshotState();
		expect(saved?.saved).toEqual(expect.arrayContaining(["durableAgentId", "plain"]));
		expect(saved?.saved).not.toContain("world");
		expect(saved?.failed.map((entry) => entry.name)).toContain("worker");
		await first.engine.kill();

		const secondEngine = new EngineManager({
			hostHandlers: first.handlers,
			snapshot: { path: snapshot, debounceMs: 600_000 },
		});
		engines.push(secondEngine);
		await secondEngine.start();
		const restored = await secondEngine.restoreState();
		expect(restored?.restored).toEqual(expect.arrayContaining(["durableAgentId", "plain"]));
		expect(restored?.restored).not.toContain("worker");
		const live = await secondEngine.execute(
			'const probe = await world.web.search("after restart"); String(plain.n) + ":" + typeof world.agents.spawn + ":" + probe.text',
		);
		expect(live.result).toContain("7:function:result: after restart");
	});
});
