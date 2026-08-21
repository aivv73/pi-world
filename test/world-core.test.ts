import { afterEach, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DEFAULT_MAX_DEPTH } from "../src/world/authority.js";
import { type DeterministicShellOptions, makeDeterministicShell } from "../src/world/deterministic-shell.js";
import {
	AgentResultSchema,
	AgentSpawnRequestSchema,
	AgentWaitRequestSchema,
	makeAgentId,
	makeAttemptId,
	makeShellExecutionId,
	ShellAttachRequestSchema,
	ShellCancelRequestSchema,
	ShellExecutionIdSchema,
	ShellOutputSchema,
	type ShellStatus,
	ShellStatusSchema,
	ShellTerminalResultSchema,
	ShellWaitRequestSchema,
	VirtualShellExecRequestSchema,
	WebSearchRequestSchema,
	WorldErrorSchema,
	WorldSubjectSchema,
} from "../src/world/domain.js";
import { makeWorldRuntime } from "../src/world/runtime.js";
import {
	attachShellExecution,
	cancelAgent,
	cancelShellExecution,
	executeVirtualShell,
	type ShellService,
	searchWeb,
	spawnAgent,
	waitForAgent,
	waitForShellExecution,
} from "../src/world/services.js";
import { makeDeterministicAgents, makeDeterministicWeb } from "../src/world/test-adapters.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const runtimes: Array<{ dispose: () => Promise<void> }> = [];

function runtime(options: Omit<Parameters<typeof makeWorldRuntime>[0], "shell"> & { readonly shell?: ShellService }) {
	const value = makeWorldRuntime({ ...options, shell: options.shell ?? makeDeterministicShell().service });
	runtimes.push(value);
	return value;
}

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((value) => value.dispose()));
});

const subject = { sessionId: "session-test", cellId: "cell-test", depth: 0 };

// The bridge will receive unknown JSON, so boundary schemas must reject malformed
// input before an adapter sees it and preserve distinct domain identities.
describe("World boundary schemas", () => {
	test("decode requests, subjects, IDs, and terminal results", () => {
		expect(Schema.decodeUnknownSync(WorldSubjectSchema)(subject)).toEqual(subject);
		const spawn = Schema.decodeUnknownSync(AgentSpawnRequestSchema)({ task: "look up Effect" });
		expect(spawn.task).toBe("look up Effect");
		const handle = {
			agentId: makeAgentId("agent-test-1"),
			attemptId: makeAttemptId("attempt-test-1"),
		};
		const result = Schema.decodeUnknownSync(AgentResultSchema)({
			_tag: "succeeded",
			agentId: handle.agentId,
			attemptId: handle.attemptId,
			output: "done",
		});
		expect(result._tag).toBe("succeeded");
		const error = Schema.decodeUnknownSync(WorldErrorSchema)({
			_tag: "AgentWaitTimeoutError",
			code: "AGENT_WAIT_TIMEOUT",
			agentId: handle.agentId,
			timeoutMs: 10,
			message: "timed out",
		});
		expect(error.code).toBe("AGENT_WAIT_TIMEOUT");
	});

	test("decodes the closed Virtual Shell tracer request and branded terminal result", () => {
		const request = Schema.decodeUnknownSync(VirtualShellExecRequestSchema, { onExcessProperty: "error" })({
			schemaVersion: 1,
			script: "echo virtual",
		});
		expect(request.script).toBe("echo virtual");
		expect(() =>
			Schema.decodeUnknownSync(VirtualShellExecRequestSchema)({ schemaVersion: 2, script: "echo virtual" }),
		).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(VirtualShellExecRequestSchema, { onExcessProperty: "error" })({
				schemaVersion: 1,
				script: "echo virtual",
				sessionId: "forged",
			}),
		).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(VirtualShellExecRequestSchema)({ schemaVersion: 1, script: "bad\0script" }),
		).toThrow();
		const executionId = Schema.decodeUnknownSync(ShellExecutionIdSchema)("shell-execution-test-1");
		expect(String(executionId)).toBe("shell-execution-test-1");

		// The wait request accepts an observation timeout without it being
		// required, and the closed taxonomy covers every terminal branch.
		const wait = Schema.decodeUnknownSync(ShellWaitRequestSchema, { onExcessProperty: "error" })({
			executionId: executionId,
			timeoutMs: 25,
		});
		expect(wait.timeoutMs).toBe(25);
		expect(Schema.decodeUnknownSync(ShellWaitRequestSchema)({ executionId: executionId }).timeoutMs).toBeUndefined();
		expect(Schema.decodeUnknownSync(ShellCancelRequestSchema)({ executionId: executionId })).toEqual({ executionId });
		expect(Schema.decodeUnknownSync(ShellAttachRequestSchema)({ executionId: executionId })).toEqual({ executionId });
		const statuses: ShellStatus[] = [
			{ _tag: "exited", exitCode: 0 },
			{ _tag: "exited", exitCode: 255 },
			{ _tag: "timed_out", timeoutMs: 0 },
			{ _tag: "cancelled", reason: "caller" },
			{ _tag: "cancelled", reason: "shutdown" },
			{ _tag: "budget_exhausted", limit: "time" },
			{ _tag: "budget_exhausted", limit: "output" },
			{ _tag: "budget_exhausted", limit: "memory" },
			{ _tag: "failed", code: "VIRTUAL_ADAPTER_FAILED" },
		];
		for (const status of statuses) expect(Schema.decodeUnknownSync(ShellStatusSchema)(status)).toEqual(status);
		expect(() => Schema.decodeUnknownSync(ShellStatusSchema)({ _tag: "exited", exitCode: 256 })).toThrow();
		expect(() => Schema.decodeUnknownSync(ShellStatusSchema)({ _tag: "exited", exitCode: -1 })).toThrow();
		expect(() => Schema.decodeUnknownSync(ShellStatusSchema)({ _tag: "cancelled", reason: "gave up" })).toThrow();
		expect(() => Schema.decodeUnknownSync(ShellStatusSchema)({ _tag: "retry", attempt: 1 })).toThrow();
		expect(() => Schema.decodeUnknownSync(ShellStatusSchema)({ _tag: "failed", code: "" })).toThrow();
		const output = {
			encoding: "base64" as const,
			data: Buffer.from([1, 2, 3]).toString("base64"),
			capturedBytes: 3,
			totalBytes: 10,
			truncated: true,
		};
		expect(Schema.decodeUnknownSync(ShellOutputSchema)(output)).toEqual(output);
		// An erased output is a schema-valid bounded record, not a new shape.
		const erased = { ...output, data: "", capturedBytes: 0 };
		expect(Schema.decodeUnknownSync(ShellOutputSchema)(erased)).toEqual(erased);
	});

	test("reject malformed or unsafe payloads", () => {
		expect(() => Schema.decodeUnknownSync(WorldSubjectSchema)({ sessionId: "s", depth: -1 })).toThrow();
		expect(() => Schema.decodeUnknownSync(AgentSpawnRequestSchema)({ task: 42 })).toThrow();
		expect(() => Schema.decodeUnknownSync(AgentWaitRequestSchema)({ agentId: "agent-1", timeoutMs: 1.5 })).toThrow();
		expect(() => Schema.decodeUnknownSync(WebSearchRequestSchema)({ query: null })).toThrow();
		expect(() => Schema.decodeUnknownSync(ShellWaitRequestSchema)({ executionId: "e", timeoutMs: 1.5 })).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(ShellWaitRequestSchema, { onExcessProperty: "error" })({
				executionId: "e",
				sessionId: "forged",
			}),
		).toThrow();
		// Output records must be exact base64 of exactly capturedBytes and the
		// truncation flag must agree with the byte counts.
		const goodOutput = {
			encoding: "base64",
			data: Buffer.from([1, 2, 3]).toString("base64"),
			capturedBytes: 3,
			totalBytes: 3,
			truncated: false,
		};
		expect(() => Schema.decodeUnknownSync(ShellOutputSchema)(goodOutput)).not.toThrow();
		expect(() => Schema.decodeUnknownSync(ShellOutputSchema)({ ...goodOutput, capturedBytes: 4 })).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(ShellOutputSchema)({ ...goodOutput, capturedBytes: 9, totalBytes: 3 }),
		).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(ShellOutputSchema)({ ...goodOutput, totalBytes: 3, truncated: true }),
		).toThrow();
		expect(() =>
			Schema.decodeUnknownSync(ShellOutputSchema)({
				...goodOutput,
				data: `${Buffer.from([1, 2, 3]).toString("base64")}!!`,
			}),
		).toThrow();
	});
});

describe("World runtime core", () => {
	test("composes independent services and fans out through one managed runtime", async () => {
		const agents = makeDeterministicAgents({ outputs: { alpha: "A", beta: "B" } });
		const web = makeDeterministicWeb();
		const world = runtime({ agents: agents.service, web: web.service });

		const handles = await Promise.all([
			world.runPromise(spawnAgent(subject, { task: "alpha" })),
			world.runPromise(spawnAgent(subject, { task: "beta" })),
		]);
		const results = await Promise.all(
			handles.map((handle) => world.runPromise(waitForAgent(subject, { agentId: handle.agentId }))),
		);
		const search = await world.runPromise(searchWeb(subject, { query: "Effect v4" }));

		expect(results.map((result) => result._tag)).toEqual(["succeeded", "succeeded"]);
		expect(results.map((result) => (result._tag === "succeeded" ? result.output : ""))).toEqual(["A", "B"]);
		expect(search.text).toBe("result: Effect v4");
		expect(agents.events.map((event) => event._tag)).toEqual(["spawned", "spawned", "waited", "waited"]);
		expect(web.queries).toEqual(["Effect v4"]);
	});

	test("admits one deterministic Virtual Shell execution and retains one immutable result", async () => {
		const shell = makeDeterministicShell();
		const world = runtime({
			agents: makeDeterministicAgents().service,
			web: makeDeterministicWeb().service,
			shell: shell.service,
		});
		const handle = await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script: "echo tracer" }));
		const first = await world.runPromise(waitForShellExecution(subject, handle));
		const second = await world.runPromise(waitForShellExecution(subject, handle));

		expect(Schema.decodeUnknownSync(ShellTerminalResultSchema)(first)).toEqual(first);
		expect(first).toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.status)).toBe(true);
		expect(first).toMatchObject({
			executionId: handle.executionId,
			mode: "virtual",
			profileId: "virtual-tracer-v1",
			status: { _tag: "exited", exitCode: 0 },
		});
		expect(shell.events.map((event) => event._tag)).toEqual(["admitted", "settled", "waited", "waited"]);
	});

	test("default authority allows the reviewed World operations and enforces recursion depth", async () => {
		const agents = makeDeterministicAgents();
		const web = makeDeterministicWeb();
		const world = runtime({ agents: agents.service, web: web.service, maxDepth: 1 });

		await expect(world.runPromise(spawnAgent({ ...subject, depth: 1 }, { task: "too deep" }))).rejects.toMatchObject({
			_tag: "WorldDenied",
			code: "WORLD_ACCESS_DENIED",
		});
		await expect(world.runPromise(searchWeb(subject, { query: "allowed" }))).resolves.toMatchObject({
			text: "result: allowed",
		});
		await expect(world.runPromise(waitForAgent(subject, { agentId: makeAgentId("missing") }))).rejects.toMatchObject({
			_tag: "AgentNotFoundError",
		});
	});

	test("an explicit allowlist is default-deny for omitted operations", async () => {
		const agents = makeDeterministicAgents();
		const web = makeDeterministicWeb();
		const world = runtime({ agents: agents.service, web: web.service, allowedOperations: ["web.search"] });

		await expect(world.runPromise(spawnAgent(subject, { task: "denied" }))).rejects.toMatchObject({
			_tag: "WorldDenied",
			operation: "agents.spawn",
		});
		await expect(world.runPromise(searchWeb(subject, { query: "allowed" }))).resolves.toBeDefined();
	});

	test("wait timeout is distinct from execution and leaves the agent waitable", async () => {
		const agents = makeDeterministicAgents({ waitDelayMs: 100, outputs: { slow: "finished" } });
		const world = runtime({ agents: agents.service, web: makeDeterministicWeb().service });
		const handle = await world.runPromise(spawnAgent(subject, { task: "slow" }));

		await expect(
			world.runPromise(waitForAgent(subject, { agentId: handle.agentId, timeoutMs: 10 })),
		).rejects.toMatchObject({
			_tag: "AgentWaitTimeoutError",
			code: "AGENT_WAIT_TIMEOUT",
		});
		await expect(world.runPromise(waitForAgent(subject, { agentId: handle.agentId }))).resolves.toMatchObject({
			_tag: "succeeded",
			output: "finished",
		});
	});

	test("cancelling one agent is isolated and idempotent", async () => {
		const agents = makeDeterministicAgents({ outputs: { keep: "kept" } });
		const world = runtime({ agents: agents.service, web: makeDeterministicWeb().service });
		const [cancelled, kept] = await Promise.all([
			world.runPromise(spawnAgent(subject, { task: "cancel" })),
			world.runPromise(spawnAgent(subject, { task: "keep" })),
		]);

		await world.runPromise(cancelAgent(subject, cancelled.agentId));
		await world.runPromise(cancelAgent(subject, cancelled.agentId));
		await expect(world.runPromise(waitForAgent(subject, { agentId: cancelled.agentId }))).resolves.toMatchObject({
			_tag: "cancelled",
		});
		await expect(world.runPromise(waitForAgent(subject, { agentId: kept.agentId }))).resolves.toMatchObject({
			_tag: "succeeded",
			output: "kept",
		});
		expect(agents.events.filter((event) => event._tag === "cancelled")).toHaveLength(1);
	});

	test("terminal failures remain typed data instead of becoming generic strings", async () => {
		const agents = makeDeterministicAgents({ failures: { broken: "child exited 7" } });
		const world = runtime({ agents: agents.service, web: makeDeterministicWeb().service });
		const handle = await world.runPromise(spawnAgent(subject, { task: "broken" }));
		const result = await world.runPromise(waitForAgent(subject, { agentId: handle.agentId }));

		expect(result).toMatchObject({ _tag: "failed", error: "child exited 7" });
	});
});

// Keep the reviewed default visible in one place so a later adapter cannot
// silently change the recursive admission policy while wiring real Pi children.
test("the static authority default is the reviewed recursion bound", () => {
	expect(DEFAULT_MAX_DEPTH).toBe(2);
});

describe("Shell execution lifecycle over the deterministic adapter", () => {
	const makeShellWorld = (options: DeterministicShellOptions = {}) => {
		const shell = makeDeterministicShell(options);
		const world = makeWorldRuntime({
			agents: makeDeterministicAgents().service,
			web: makeDeterministicWeb().service,
			shell: shell.service,
		});
		runtimes.push(world);
		return { shell, world };
	};

	test("wait timeout withdraws observation without cancelling or changing the admitted execution", async () => {
		const { shell, world } = makeShellWorld({ executionMs: 200 });
		const handle = await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script: "slow" }));

		await expect(
			world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId, timeoutMs: 20 })),
		).rejects.toMatchObject({
			_tag: "ShellWaitTimeoutError",
			code: "SHELL_WAIT_TIMEOUT",
			operation: "shell.wait",
			timeoutMs: 20,
		});
		expect(shell.pendingCount()).toBe(1);
		expect(shell.events.some((event) => event._tag === "cancelled")).toBe(false);

		const terminal = await world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId }));
		expect(terminal.status).toEqual({ _tag: "exited", exitCode: 0 });
		expect(terminal.started).toBe(true);
		expect(shell.pendingCount()).toBe(0);
	});

	test("a wait timeout on an unknown ID is not-found, not a wait timeout", async () => {
		const { world } = makeShellWorld();
		const unknownId = makeShellExecutionId("00000000-0000-0000-0000-000000000000");
		await expect(
			world.runPromise(waitForShellExecution(subject, { executionId: unknownId, timeoutMs: 5 })),
		).rejects.toMatchObject({
			_tag: "ShellExecutionNotFound",
			code: "SHELL_EXECUTION_NOT_FOUND",
		});
	});

	test("awaited repeated cancellations and repeated waits converge on the identical retained result", async () => {
		const { shell, world } = makeShellWorld({ executionMs: 60 });
		const handle = await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script: "cancel me" }));

		await world.runPromise(cancelShellExecution(subject, { executionId: handle.executionId }));
		await world.runPromise(cancelShellExecution(subject, { executionId: handle.executionId }));
		const first = await world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId }));
		const second = await world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId }));

		expect(first).toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(first.status).toEqual({ _tag: "cancelled", reason: "caller" });
		expect(shell.events.filter((event) => event._tag === "cancelled")).toHaveLength(1);
		expect(shell.pendingCount()).toBe(0);
	});

	test("every admitted execution reaches exactly one branch of the closed v1 taxonomy", async () => {
		const configs: Array<{ readonly options: DeterministicShellOptions; readonly branch: ShellStatus["_tag"] }> = [
			{ options: {}, branch: "exited" },
			{
				options: { outcome: () => ({ _tag: "exited", exitCode: 7, stdoutBytes: 100, stderrBytes: 4 }) },
				branch: "exited",
			},
			{
				options: { outcome: () => ({ _tag: "budget_exhausted", limit: "output", stdoutBytes: 300 }) },
				branch: "budget_exhausted",
			},
			{ options: { outcome: () => ({ _tag: "failed", code: "VIRTUAL_ADAPTER_FAILED" }) }, branch: "failed" },
			{ options: { executionMs: 60, executionTimeoutMs: 20 }, branch: "timed_out" },
		];
		const branches = new Set<string>();

		for (const config of configs) {
			const { shell, world } = makeShellWorld(config.options);
			const handle = await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script: "branch" }));
			const terminal = await world.runPromise(
				waitForShellExecution(subject, { executionId: handle.executionId, timeoutMs: 5_000 }),
			);
			expect(Schema.decodeUnknownSync(ShellTerminalResultSchema)(terminal)).toEqual(terminal);
			expect(terminal.status._tag).toBe(config.branch);
			expect(shell.pendingCount()).toBe(0);
			branches.add(terminal.status._tag);
		}

		const cancelledWorld = makeShellWorld({ executionMs: 60 });
		const cancelledHandle = await cancelledWorld.world.runPromise(
			executeVirtualShell(subject, { schemaVersion: 1, script: "branch cancel" }),
		);
		await cancelledWorld.world.runPromise(cancelShellExecution(subject, { executionId: cancelledHandle.executionId }));
		const cancelled = await cancelledWorld.world.runPromise(
			waitForShellExecution(subject, { executionId: cancelledHandle.executionId }),
		);
		branches.add(cancelled.status._tag);

		expect([...branches].sort()).toEqual(["budget_exhausted", "cancelled", "exited", "failed", "timed_out"]);
	});

	test("declared output is a bounded binary-safe capture with truncation semantics", async () => {
		const { world } = makeShellWorld({
			outcome: () => ({ _tag: "exited", exitCode: 0, stdoutBytes: 200, stderrBytes: 10 }),
		});
		const handle = await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script: "output" }));
		const terminal = await world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId }));

		expect(terminal.stdout).toMatchObject({
			encoding: "base64",
			capturedBytes: 200,
			totalBytes: 200,
			truncated: false,
		});
		expect(Buffer.from(terminal.stdout.data, "base64").length).toBe(200);
		expect(terminal.stderr).toMatchObject({ capturedBytes: 10, totalBytes: 10, truncated: false });
		expect(terminal.sideEffectsMayHaveOccurred).toBe(false);
		expect(terminal.profileId).toBe("virtual-tracer-v1");
		expect(terminal.virtualState).toEqual({ disposition: "unchanged" });
		expect(terminal.cleanup).toBe("not_needed");
	});

	test("a cancelled queued execution reports it as never started and without output", async () => {
		const { world } = makeShellWorld({
			queueMs: 40,
			executionMs: 20,
			outcome: () => ({ _tag: "exited", exitCode: 0, stdoutBytes: 10 }),
		});
		const handle = await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script: "queued" }));
		await world.runPromise(cancelShellExecution(subject, { executionId: handle.executionId }));
		const terminal = await world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId }));

		expect(terminal.started).toBe(false);
		expect(terminal.queueDurationBucket).toBe("lt_10ms");
		expect(terminal.runtimeDurationBucket).toBe("lt_10ms");
		expect(terminal.stdout).toMatchObject({ capturedBytes: 0, totalBytes: 0, truncated: false });
	});

	test("a timeout budget shorter than the simulated run yields timed_out with the budget", async () => {
		const { world } = makeShellWorld({ queueMs: 10, executionMs: 60, executionTimeoutMs: 20 });
		const handle = await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script: "budget" }));
		const terminal = await world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId }));

		expect(terminal.status).toEqual({ _tag: "timed_out", timeoutMs: 20 });
		expect(terminal.started).toBe(true);
	});

	test("exact-ID attach succeeds for the owner session, and every refusal is indistinguishable", async () => {
		const { world } = makeShellWorld();
		const handle = await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script: "attach" }));
		const foreign = { sessionId: "other-session", depth: 1 };
		const unknownId = makeShellExecutionId("00000000-0000-0000-0000-000000000000");

		// Attach also recovers a handle for a pending (not yet settled) execution.
		const pendingWorld = makeShellWorld({ executionMs: 50 });
		const pendingHandle = await pendingWorld.world.runPromise(
			executeVirtualShell(subject, { schemaVersion: 1, script: "pending attach" }),
		);
		const pendingRecovered = await pendingWorld.world.runPromise(
			attachShellExecution(subject, { executionId: pendingHandle.executionId }),
		);
		expect(pendingRecovered.executionId).toBe(pendingHandle.executionId);
		expect(
			(await pendingWorld.world.runPromise(waitForShellExecution(subject, pendingRecovered))).status,
		).toMatchObject({
			_tag: "exited",
		});

		// The owner session may attach from any of its cells.
		const otherCell = { sessionId: subject.sessionId, cellId: "another-cell", depth: 0 };
		const recovered = await world.runPromise(attachShellExecution(otherCell, { executionId: handle.executionId }));
		expect(recovered.executionId).toBe(handle.executionId);

		const unknownAttach = (await world
			.runPromise(attachShellExecution(subject, { executionId: unknownId }))
			.catch((error) => error)) as object;
		const foreignAttach = (await world
			.runPromise(attachShellExecution(foreign, { executionId: handle.executionId }))
			.catch((error) => error)) as object;
		expect(foreignAttach).toEqual(unknownAttach);
		expect(unknownAttach).toMatchObject({
			_tag: "ShellExecutionNotFound",
			code: "SHELL_EXECUTION_NOT_FOUND",
			operation: "shell.attach",
		});

		const unknownWait = (await world
			.runPromise(waitForShellExecution(subject, { executionId: unknownId }))
			.catch((error) => error)) as object;
		const foreignWait = (await world
			.runPromise(waitForShellExecution(foreign, { executionId: handle.executionId }))
			.catch((error) => error)) as object;
		expect(foreignWait).toEqual(unknownWait);

		const unknownCancel = (await world
			.runPromise(cancelShellExecution(subject, { executionId: unknownId }))
			.catch((error) => error)) as object;
		const foreignCancel = (await world
			.runPromise(cancelShellExecution(foreign, { executionId: handle.executionId }))
			.catch((error) => error)) as object;
		expect(foreignCancel).toEqual(unknownCancel);
	});

	test("expired IDs become indistinguishable from unknown ones", async () => {
		const { shell, world } = makeShellWorld({ expireAfterMs: 15 });
		const handle = await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script: "expires" }));
		expect(
			(await world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId }))).status,
		).toMatchObject({
			_tag: "exited",
		});
		await sleep(30);

		const expiredAttach = (await world
			.runPromise(attachShellExecution(subject, { executionId: handle.executionId }))
			.catch((error) => error)) as object;
		const unknownAttach = (await world
			.runPromise(
				attachShellExecution(subject, { executionId: makeShellExecutionId("00000000-0000-0000-0000-000000000000") }),
			)
			.catch((error) => error)) as object;
		expect(expiredAttach).toEqual(unknownAttach);
		expect(shell.recordCount()).toBe(0);
	});

	test("a pending execution evicted by retention terminates as a shutdown cancellation", async () => {
		const { world } = makeShellWorld({ executionMs: 200, expireAfterMs: 25 });
		const handle = await world.runPromise(
			executeVirtualShell(subject, { schemaVersion: 1, script: "evicted while pending" }),
		);
		const waitPromise = world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId }));
		await sleep(50);

		const attachAfter = (await world
			.runPromise(attachShellExecution(subject, { executionId: handle.executionId }))
			.catch((error) => error)) as object;
		expect(attachAfter).toMatchObject({ _tag: "ShellExecutionNotFound", code: "SHELL_EXECUTION_NOT_FOUND" });

		const terminal = await waitPromise;
		expect(terminal.status).toEqual({ _tag: "cancelled", reason: "shutdown" });
		expect(terminal.sideEffectsMayHaveOccurred).toBe(false);
	});

	test("retention erases output before metadata when the payload cap is exceeded", async () => {
		const { world } = makeShellWorld({
			outputCharsCap: 100,
			outcome: () => ({ _tag: "exited", exitCode: 0, stdoutBytes: 500 }),
		});
		const handle = await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script: "big output" }));

		const terminal = await world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId }));
		expect(terminal.stdout).toMatchObject({
			encoding: "base64",
			data: "",
			capturedBytes: 0,
			totalBytes: 500,
			truncated: true,
		});
		// Metadata outlives output: the execution is still attachable and the
		// retained record is stable across waits.
		const recovered = await world.runPromise(attachShellExecution(subject, { executionId: handle.executionId }));
		expect(recovered.executionId).toBe(handle.executionId);
		const again = await world.runPromise(waitForShellExecution(subject, { executionId: handle.executionId }));
		expect(again).toBe(terminal);
	});

	test("the session records cap evicts the oldest whole record first", async () => {
		const { world } = makeShellWorld({ recordsCap: 2 });
		const handles = [] as Array<ReturnType<typeof makeShellExecutionId>>;
		for (const script of ["one", "two", "three"]) {
			handles.push((await world.runPromise(executeVirtualShell(subject, { schemaVersion: 1, script }))).executionId);
		}

		const first = (await world
			.runPromise(waitForShellExecution(subject, { executionId: handles[0]! }))
			.catch((error) => error)) as object;
		expect(first).toMatchObject({ _tag: "ShellExecutionNotFound", code: "SHELL_EXECUTION_NOT_FOUND" });
		const second = await world.runPromise(waitForShellExecution(subject, { executionId: handles[1]! }));
		const third = await world.runPromise(waitForShellExecution(subject, { executionId: handles[2]! }));
		expect(second.status._tag).toBe("exited");
		expect(third.status._tag).toBe("exited");
	});
});
