import { afterEach, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DEFAULT_MAX_DEPTH } from "../src/world/authority.js";
import { makeDeterministicShell } from "../src/world/deterministic-shell.js";
import {
	AgentResultSchema,
	AgentSpawnRequestSchema,
	AgentWaitRequestSchema,
	makeAgentId,
	makeAttemptId,
	ShellExecutionIdSchema,
	ShellTerminalResultSchema,
	VirtualShellExecRequestSchema,
	WebSearchRequestSchema,
	WorldErrorSchema,
	WorldSubjectSchema,
} from "../src/world/domain.js";
import { makeWorldRuntime } from "../src/world/runtime.js";
import {
	cancelAgent,
	executeVirtualShell,
	type ShellService,
	searchWeb,
	spawnAgent,
	waitForAgent,
	waitForShellExecution,
} from "../src/world/services.js";
import { makeDeterministicAgents, makeDeterministicWeb } from "../src/world/test-adapters.js";

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
	});

	test("reject malformed or unsafe payloads", () => {
		expect(() => Schema.decodeUnknownSync(WorldSubjectSchema)({ sessionId: "s", depth: -1 })).toThrow();
		expect(() => Schema.decodeUnknownSync(AgentSpawnRequestSchema)({ task: 42 })).toThrow();
		expect(() => Schema.decodeUnknownSync(AgentWaitRequestSchema)({ agentId: "agent-1", timeoutMs: 1.5 })).toThrow();
		expect(() => Schema.decodeUnknownSync(WebSearchRequestSchema)({ query: null })).toThrow();
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
		expect(shell.events.map((event) => event._tag)).toEqual(["admitted", "waited", "waited"]);
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
