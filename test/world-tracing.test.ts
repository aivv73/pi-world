import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Tracer } from "effect";
import { createSessionWorld } from "../src/extension/session-world.js";
import { makeInMemoryWorldTracer, WORLD_SPANS, WORLD_TRACE_ATTRIBUTE_KEYS } from "../src/world/tracing.js";

const tempDirs: string[] = [];
const worlds: Array<{ dispose: () => Promise<void> }> = [];

const tempDir = () => {
	const path = mkdtempSync(join(tmpdir(), "pi-world-tracing-"));
	tempDirs.push(path);
	return path;
};

const context = () =>
	({
		model: undefined,
		modelRegistry: { credentialCanary: "credential-canary-8" },
		sessionManager: { getSessionId: () => "session-trace" },
	}) as unknown as ExtensionContext;

afterEach(async () => {
	await Promise.allSettled(worlds.splice(0).map((world) => world.dispose()));
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const parentOf = (spans: ReturnType<ReturnType<typeof makeInMemoryWorldTracer>["spans"]>, childName: string) => {
	const child = spans.find((span) => span.name === childName);
	return spans.find((span) => span.spanId === child?.parentSpanId);
};

const auditExits = (memory: ReturnType<typeof makeInMemoryWorldTracer>, endedExits: string[]) =>
	Tracer.make({
		span(options) {
			const span = memory.tracer.span(options);
			const end = span.end.bind(span);
			span.end = (endTime, exit) => {
				endedExits.push(JSON.stringify(exit));
				end(endTime, exit);
			};
			return span;
		},
	});

describe("World tracing", () => {
	test("records privacy-safe parentage across the session-owned process fiber", async () => {
		const root = tempDir();
		const script = join(root, "child.mjs");
		writeFileSync(
			script,
			[
				// No escape sequences here: an escaped newline in this TypeScript
				// string becomes a real newline in the generated child, which
				// silently crashes the child the moment it parses.
				'process.stderr.write("stderr-canary-8");',
				// A long-lived child keeps the attempt/process spans safely in
				// their started state until the test asserts on them.
				"setTimeout(() => { process.stdout.write('output-canary-8'); process.exit(0); }, 2000);",
			].join("\n"),
		);
		const memory = makeInMemoryWorldTracer();
		const endedExits: string[] = [];
		const world = createSessionWorld({
			cwd: root,
			extensionPath: "/installed/pi-world/index.ts",
			sessionDir: join(root, "agents"),
			sessionId: "session-trace",
			defaultModel: "provider/model-canary-8",
			depth: 1,
			maxDepth: 2,
			getContext: context,
			spawnCommand: () => ({ command: process.execPath, args: [script], env: { SECRET_CANARY: "env-canary-8" } }),
			executeWeb: async () => ({ text: "web-result-canary-8", details: { hidden: "detail-canary-8" } }),
			tracer: auditExits(memory, endedExits),
		});
		worlds.push(world);
		const call = { signal: new AbortController().signal, cellId: "cell-trace" };
		await world.handlers["world.web.search"]!({ request: { query: "query-canary-8" } }, call);
		const shellHandle = await world.handlers["world.shell.virtual.exec"]!(
			{ request: { schemaVersion: 1, script: "shell-script-canary-8" } },
			call,
		);
		await world.handlers["world.shell.wait"]!({ request: { executionId: shellHandle.executionId } }, call);
		const handle = await world.handlers["world.agents.spawn"]!(
			{ request: { task: "prompt-canary-8", model: "provider/model-canary-8" } },
			call,
		);
		for (let attempt = 0; attempt < 40; attempt++) {
			const names = memory.spans().map((span) => span.name);
			if (names.includes(WORLD_SPANS.agentAttempt) && names.includes(WORLD_SPANS.piProcess)) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const open = memory.spans();
		expect(open.find((span) => span.name === WORLD_SPANS.agentAttempt)?.status).toBe("started");
		expect(open.find((span) => span.name === WORLD_SPANS.piProcess)?.status).toBe("started");

		await world.handlers["world.agents.wait"]!({ request: { agentId: handle.agentId } }, call);
		const spans = memory.spans();
		expect(parentOf(spans, WORLD_SPANS.webSearch)?.name).toBe(WORLD_SPANS.coordinator);
		expect(parentOf(spans, WORLD_SPANS.shellVirtualExec)?.name).toBe(WORLD_SPANS.coordinator);
		expect(parentOf(spans, WORLD_SPANS.shellWait)?.name).toBe(WORLD_SPANS.coordinator);
		expect(parentOf(spans, WORLD_SPANS.agentSpawn)?.name).toBe(WORLD_SPANS.coordinator);
		expect(parentOf(spans, WORLD_SPANS.agentAttempt)?.name).toBe(WORLD_SPANS.agentSpawn);
		expect(parentOf(spans, WORLD_SPANS.piProcess)?.name).toBe(WORLD_SPANS.agentAttempt);
		expect(parentOf(spans, WORLD_SPANS.agentWait)?.name).toBe(WORLD_SPANS.coordinator);
		expect(spans.find((span) => span.name === WORLD_SPANS.agentAttempt)?.status).toBe("succeeded");
		expect(spans.find((span) => span.name === WORLD_SPANS.piProcess)?.status).toBe("succeeded");

		const allowed = new Set<string>(WORLD_TRACE_ATTRIBUTE_KEYS);
		for (const span of spans) {
			for (const key of Object.keys(span.attributes)) expect(allowed.has(key)).toBe(true);
		}
		const exported = JSON.stringify(spans);
		const exportedExits = JSON.stringify(endedExits);
		for (const canary of [
			"prompt-canary-8",
			"query-canary-8",
			"output-canary-8",
			"stderr-canary-8",
			"web-result-canary-8",
			"detail-canary-8",
			"credential-canary-8",
			"env-canary-8",
			"model-canary-8",
			"shell-script-canary-8",
		]) {
			expect(exported).not.toContain(canary);
			expect(exportedExits).not.toContain(canary);
		}
	});

	test("failure spans retain a stable code but no raw provider error", async () => {
		const root = tempDir();
		const memory = makeInMemoryWorldTracer();
		const endedExits: string[] = [];
		const auditedTracer = auditExits(memory, endedExits);
		const world = createSessionWorld({
			cwd: root,
			extensionPath: "/installed/pi-world/index.ts",
			sessionDir: join(root, "agents"),
			sessionId: "session-trace-failure",
			defaultModel: "provider/model",
			depth: 0,
			maxDepth: 2,
			getContext: context,
			spawnCommand: () => ({ command: process.execPath, args: ["--version"] }),
			executeWeb: async () => {
				throw new Error("raw-provider-secret-canary-8");
			},
			tracer: auditedTracer,
		});
		worlds.push(world);
		await expect(
			world.handlers["world.web.search"]!(
				{ request: { query: "failure-query-canary-8" } },
				{ signal: new AbortController().signal, cellId: "failure-cell" },
			),
		).rejects.toBeDefined();
		await expect(
			world.handlers["world.agents.wait"]!(
				{ request: { agentId: "forged-agent-canary-8" } },
				{ signal: new AbortController().signal, cellId: "failure-cell" },
			),
		).rejects.toBeDefined();
		const spans = memory.spans();
		const web = spans.find((span) => span.name === WORLD_SPANS.webSearch);
		// The semantic outcome is an attribute; the tracer receives only a
		// successful void Exit, never the typed failure or its raw Cause.
		expect(web?.status).toBe("succeeded");
		expect(web?.attributes["world.outcome"]).toBe("failed");
		expect(web?.attributes["world.error_code"]).toBe("WEB_SEARCH_FAILED");
		expect(JSON.stringify(endedExits)).not.toContain("raw-provider-secret-canary-8");
		expect(JSON.stringify(spans)).not.toContain("raw-provider-secret-canary-8");
		expect(JSON.stringify(spans)).not.toContain("failure-query-canary-8");
		expect(JSON.stringify(spans)).not.toContain("forged-agent-canary-8");
	});
});
