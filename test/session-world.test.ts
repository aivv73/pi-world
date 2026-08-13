import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension/index.js";
import { buildRlmTsPrompt } from "../src/extension/prompt.js";
import { createSessionWorld, type SessionWorld, SessionWorldOwner } from "../src/extension/session-world.js";
import { makeAgentId, makeAttemptId } from "../src/world/domain.js";
import { makePiChildSpec } from "../src/world/pi-process-agents.js";

const tempDirs: string[] = [];
const worlds: Array<{ dispose: () => Promise<void> }> = [];

const tempDir = () => {
	const path = mkdtempSync(join(tmpdir(), "pi-world-session-"));
	tempDirs.push(path);
	return path;
};

const context = (root: string, sessionId = "session-host-owned") =>
	({
		cwd: root,
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
		},
	}) as unknown as ExtensionContext;

const isAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

afterEach(async () => {
	await Promise.allSettled(worlds.splice(0).map((world) => world.dispose()));
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("session World composition", () => {
	test("one runtime serves Web and Agents and shutdown leaves no attached child", async () => {
		const root = tempDir();
		const readyFile = join(root, "ready.json");
		const stoppedFile = join(root, "stopped.txt");
		const childScript = join(root, "child.mjs");
		writeFileSync(
			childScript,
			[
				'import fs from "node:fs";',
				`fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ pid: process.pid }));`,
				`process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(stoppedFile)}, "stopped"); process.exit(0); });`,
				"setInterval(() => {}, 1000);",
			].join("\n"),
		);
		let liveContext = context(root);
		let observedContext: ExtensionContext | undefined;
		const world = createSessionWorld({
			cwd: root,
			extensionPath: "/installed/pi-world/index.ts",
			sessionDir: join(root, "agents"),
			sessionId: "session-host-owned",
			defaultModel: "openai-codex/gpt-5.6-luna",
			depth: 0,
			maxDepth: 2,
			getContext: () => liveContext,
			spawnCommand: () => ({ command: process.execPath, args: [childScript] }),
			executeWeb: async (_params, ctx) => {
				observedContext = ctx;
				return { text: "hidden web result", details: { adapter: "fixture" } };
			},
		});
		worlds.push(world);
		const call = { signal: new AbortController().signal, cellId: "cell-host-owned" };

		const web = await world.handlers["world.web.search"]!({ request: { query: "Effect runtime" } }, call);
		expect(web).toEqual({ text: "hidden web result", details: { adapter: "fixture" } });
		expect(observedContext).toBe(liveContext);
		const refreshedContext = context(root, "session-auth-refreshed");
		liveContext = refreshedContext;
		await world.handlers["world.web.search"]!({ request: { query: "fresh auth" } }, call);
		expect(observedContext).toBe(refreshedContext);
		const handle = await world.handlers["world.agents.spawn"]!({ request: { task: "stay attached" } }, call);
		for (let attempt = 0; attempt < 80 && !existsSync(readyFile); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		const pid = (JSON.parse(readFileSync(readyFile, "utf8")) as { pid: number }).pid;
		expect(isAlive(pid)).toBe(true);
		expect(handle).toMatchObject({ agentId: expect.stringContaining("agent-"), attemptId: expect.any(String) });

		await world.dispose();
		worlds.splice(worlds.indexOf(world), 1);
		expect(readFileSync(stoppedFile, "utf8")).toBe("stopped");
		expect(isAlive(pid)).toBe(false);
	});

	test("the session owner survives evaluator generations and disposes exactly once", async () => {
		let created = 0;
		let disposed = 0;
		const fixture = {
			runtime: {},
			handlers: {},
			dispose: async () => {
				disposed += 1;
			},
		} as unknown as SessionWorld;
		const owner = new SessionWorldOwner(() => {
			created += 1;
			return fixture;
		});
		const options = {
			cwd: "/workspace",
			extensionPath: "/installed/pi-world/index.ts",
			sessionDir: "/workspace/agents",
			sessionId: "session-one",
			defaultModel: "openai-codex/gpt-5.6-luna",
			depth: 0,
			maxDepth: 2,
			getContext: () => context("/workspace"),
		};
		expect(owner.acquire(options)).toBe(fixture);
		// An evaluator discard/rebuild reacquires handlers but not the World.
		expect(owner.acquire(options)).toBe(fixture);
		expect(created).toBe(1);
		expect(disposed).toBe(0);
		await owner.shutdown();
		expect(disposed).toBe(1);
		await owner.shutdown();
		expect(disposed).toBe(1);
	});

	test("the model prompt exposes only the Promise World contract", () => {
		const prompt = buildRlmTsPrompt({ cwd: "/workspace", depth: 0, allowRecursion: false });
		expect(prompt).toContain("world.agents.spawnMany(tasks)");
		expect(prompt).toContain("world.web.search(query)");
		expect(prompt).toContain("no World list/status polling API");
		expect(prompt).not.toContain("ManagedRuntime");
	});

	test("production child spec disables package discovery and loads this fork exactly once", () => {
		const spec = makePiChildSpec(
			{
				cwd: "/workspace",
				extensionPath: "/installed/@aivv/pi-world/src/extension/index.ts",
				sessionDir: "/workspace/.pi-rlm/session/world-agents",
				defaultModel: "openai-codex/gpt-5.6-luna",
				depth: 0,
			},
			{
				handle: { agentId: makeAgentId("agent-test"), attemptId: makeAttemptId("attempt-test") },
				request: { task: "child task" },
			},
		);
		expect(spec.command).toBe("pi");
		expect(spec.args.filter((arg) => arg === "--no-extensions")).toHaveLength(1);
		expect(spec.args.filter((arg) => arg === "-e")).toHaveLength(1);
		expect(spec.args.filter((arg) => arg === "/installed/@aivv/pi-world/src/extension/index.ts")).toHaveLength(1);
		expect(spec.args).not.toContain("--rlm");
	});
});

interface CapturedExecuteTool {
	readonly name: string;
	readonly execute: (
		toolCallId: string,
		params: { code: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text?: string }> }>;
}

describe("installed extension activation", () => {
	test("installation always collapses the model-visible surface to execute", async () => {
		const root = tempDir();
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>();
		const registeredTools: string[] = [];
		let executeTool: CapturedExecuteTool | undefined;
		const registeredFlags: string[] = [];
		let activeTools: string[] = ["read", "bash", "edit"];
		const pi = {
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => {
				const entries = handlers.get(name) ?? [];
				entries.push(handler);
				handlers.set(name, entries);
			},
			registerTool: (tool: unknown) => {
				const captured = tool as CapturedExecuteTool;
				registeredTools.push(captured.name);
				executeTool = captured;
			},
			registerFlag: (name: string) => registeredFlags.push(name),
			setActiveTools: (names: string[]) => {
				activeTools = names;
			},
			getActiveTools: () => activeTools,
			sendMessage: () => {},
		} as unknown as ExtensionAPI;
		extension(pi);
		const ctx = context(root);
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		expect(registeredTools).toEqual(["execute"]);
		expect(registeredFlags).toEqual([]);
		expect(activeTools).toEqual(["execute"]);

		const bindings = await executeTool!.execute(
			"cell-bindings",
			{ code: "({ world: typeof world.agents.spawn, rlm: typeof rlm.run, tools: typeof tools.read })" },
			undefined,
			undefined,
			ctx,
		);
		const bindingText = bindings.content.map((block) => block.text ?? "").join("\n");
		expect(bindingText).toContain('world: "function"');
		expect(bindingText).toContain('rlm: "function"');
		expect(bindingText).toContain('tools: "function"');
		await expect(
			executeTool!.execute("cell-world-host", { code: 'await world.web.search("")' }, undefined, undefined, ctx),
		).rejects.toThrow("web search query must not be empty");

		const nextSession = context(root, "session-two");
		for (const handler of handlers.get("session_start") ?? []) await handler({}, nextSession);
		const switched = await executeTool!.execute(
			"cell-next-session",
			{ code: "typeof world.web.search" },
			undefined,
			undefined,
			nextSession,
		);
		expect(switched.content.map((block) => block.text ?? "").join("\n")).toContain("function");

		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	});
});
