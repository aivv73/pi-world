import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { makeAgentId } from "../src/world/domain.js";
import { makePiProcessAgents, PiProcessAgentsLive } from "../src/world/pi-process-agents.js";
import { Agents } from "../src/world/services.js";

const tempDirs: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];

const tempDir = () => {
	const value = mkdtempSync(join(tmpdir(), "pi-world-agents-"));
	tempDirs.push(value);
	return value;
};

const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return condition();
};

const options = (script: (task: string) => string) => ({
	cwd: tempDir(),
	defaultModel: "anthropic/haiku",
	depth: 0,
	graceMs: 50,
	spawnCommand: ({ request }: { request: { task: string } }) => ({
		command: "sh",
		args: ["-c", script(request.task)],
	}),
});

const request = (task: string, timeoutMs?: number) => ({ task, ...(timeoutMs === undefined ? {} : { timeoutMs }) });

const dispose = async () => {
	await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
};

afterEach(dispose);

describe("Pi process Agents", () => {
	test("admission returns a handle and wait settles from the close event", async () => {
		const agents = makePiProcessAgents(options(() => 'sleep 0.1; printf "child-answer"'));
		const handle = await Effect.runPromise(agents.spawn(request("answer")));

		expect(handle.agentId).toMatch(/^agent-/);
		const result = await Effect.runPromise(agents.wait({ agentId: handle.agentId }));

		expect(result).toMatchObject({ _tag: "succeeded", output: "child-answer" });
		expect(agents.events.map((event) => event._tag)).toEqual(["spawned", "completed"]);
	});

	test("wait timeout does not terminate the child", async () => {
		const agents = makePiProcessAgents(options(() => 'sleep 0.15; printf "still-running"'));
		const handle = await Effect.runPromise(agents.spawn(request("wait")));

		await expect(Effect.runPromise(agents.wait({ agentId: handle.agentId, timeoutMs: 10 }))).rejects.toMatchObject({
			_tag: "AgentWaitTimeoutError",
			code: "AGENT_WAIT_TIMEOUT",
		});
		const result = await Effect.runPromise(agents.wait({ agentId: handle.agentId }));

		expect(result).toMatchObject({ _tag: "succeeded", output: "still-running" });
		expect(agents.events.some((event) => event._tag === "term_sent")).toBe(false);
	});

	test("cancelling one child is bounded, awaited, and isolated from siblings", async () => {
		const agents = makePiProcessAgents(
			options((task) => (task === "cancel" ? "sleep 60" : 'sleep 0.1; printf "sibling"')),
		);
		const cancelled = await Effect.runPromise(agents.spawn(request("cancel")));
		const sibling = await Effect.runPromise(agents.spawn(request("sibling")));

		await Effect.runPromise(agents.cancel(cancelled.agentId));
		const [cancelledResult, siblingResult] = await Promise.all([
			Effect.runPromise(agents.wait({ agentId: cancelled.agentId })),
			Effect.runPromise(agents.wait({ agentId: sibling.agentId })),
		]);

		expect(cancelledResult).toMatchObject({ _tag: "cancelled" });
		expect(siblingResult).toMatchObject({ _tag: "succeeded", output: "sibling" });
		expect(agents.events.map((event) => event._tag)).toContain("term_sent");
	});

	test("a nonzero child exit is a typed failure distinct from cancellation", async () => {
		const agents = makePiProcessAgents(options(() => "exit 7"));
		const handle = await Effect.runPromise(agents.spawn(request("failed")));
		const result = await Effect.runPromise(agents.wait({ agentId: handle.agentId }));

		expect(result).toMatchObject({ _tag: "failed", error: "child exited with code 7" });
		expect(agents.events.map((event) => event._tag)).toContain("failed");
	});

	test("execution timeout terminates the child and produces a distinct terminal result", async () => {
		const agents = makePiProcessAgents(options(() => "sleep 60"));
		const handle = await Effect.runPromise(agents.spawn(request("timeout", 20)));
		const result = await Effect.runPromise(agents.wait({ agentId: handle.agentId }));

		expect(result).toMatchObject({ _tag: "timed_out", timeoutMs: 20 });
		expect(agents.events.map((event) => event._tag)).toContain("timed_out");
	});

	test("unknown waits are typed and shutdown cancels every attached child", async () => {
		const agents = makePiProcessAgents(options(() => "sleep 60"));
		await expect(Effect.runPromise(agents.wait({ agentId: makeAgentId("missing") }))).rejects.toMatchObject({
			_tag: "AgentNotFoundError",
		});
		await Effect.runPromise(agents.spawn(request("one")));
		await Effect.runPromise(agents.spawn(request("two")));

		await Effect.runPromise(agents.shutdown());
		expect(agents.events.filter((event) => event._tag === "cancelled")).toHaveLength(2);
	});

	test("the Agents layer owns child cleanup when its managed runtime closes", async () => {
		const directory = tempDir();
		const pidPath = join(directory, "child.pid");
		const world = ManagedRuntime.make(
			PiProcessAgentsLive({
				cwd: directory,
				defaultModel: "anthropic/haiku",
				depth: 0,
				graceMs: 50,
				spawnCommand: () => ({
					command: "sh",
					args: ["-c", `printf '%s' "$$" > ${JSON.stringify(pidPath)}; sleep 60`],
				}),
			}),
		);
		runtimes.push(world);
		await world.runPromise(
			Effect.gen(function* () {
				const service = yield* Agents;
				return yield* service.spawn(request("owned"));
			}),
		);
		expect(await waitFor(() => existsSync(pidPath))).toBe(true);
		const pid = Number(readFileSync(pidPath, "utf8"));
		await world.dispose();
		await waitFor(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		});
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	});
});
