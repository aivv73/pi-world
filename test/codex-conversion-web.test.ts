import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeCodexWebSearch } from "@howaboua/pi-codex-conversion/dist/tools/web-run/tool.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { StaticAuthorityLive } from "../src/world/authority.js";
import {
	CODEX_CONVERSION_WEB_IMPORT,
	CodexConversionWebLive,
	makeCodexConversionWeb,
} from "../src/world/codex-conversion-web.js";
import { searchWeb } from "../src/world/services.js";

const tempDirs: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];

const tempDir = () => {
	const path = mkdtempSync(join(tmpdir(), "pi-world-codex-web-"));
	tempDirs.push(path);
	return path;
};

const codexModel = {
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
} as const;

// The pinned executor reads only these live fields, but its public signature
// intentionally accepts Pi's full context.
const context = (sessionId = "session-codex-test") =>
	({
		model: codexModel,
		modelRegistry: {
			getApiKeyAndHeaders: async (model: unknown) => {
				expect(model).toBe(codexModel);
				return {
					ok: true as const,
					apiKey: "credential-fixture-token",
					headers: { "chatgpt-account-id": "fixture-account" },
					baseUrl: "https://chatgpt.com/backend-api",
				};
			},
		},
		sessionManager: { getSessionId: () => sessionId },
	}) as unknown as ExtensionContext;

const fakeBinary = (directory: string, options: { delayMs?: number; readyFile?: string; signalFile?: string } = {}) => {
	const binary = join(directory, "web_run");
	const readyLine = options.readyFile
		? `fs.writeFileSync(${JSON.stringify(options.readyFile)}, ${JSON.stringify("ready")});`
		: "";
	const signalLine = options.signalFile
		? `fs.writeFileSync(${JSON.stringify(options.signalFile)}, ${JSON.stringify("terminated")});`
		: "";
	writeFileSync(
		binary,
		[
			"#!/usr/bin/env node",
			'const fs = require("node:fs");',
			readyLine,
			'let body = "";',
			'process.stdin.setEncoding("utf8");',
			'process.stdin.on("data", (chunk) => { body += chunk; });',
			`process.on("SIGTERM", () => { ${signalLine} process.exit(143); });`,
			'process.stdin.on("end", () => {',
			"  const input = JSON.parse(body);",
			"  setTimeout(() => process.stdout.write(JSON.stringify({",
			'    output: "native-result:" + input.search_query[0].q,',
			"    observed: {",
			"      id: input.id, requestModel: input.model, providerModel: process.env.PI_CODEX_MODEL,",
			'      authReused: process.env.PI_CODEX_ACCESS_TOKEN === "credential-fixture-token",',
			'      accountReused: process.env.PI_CODEX_ACCOUNT_ID === "fixture-account",',
			"      baseUrl: process.env.PI_CODEX_BASE_URL, responsesUrl: process.env.PI_CODEX_RESPONSES_URL,",
			"      searchUrl: process.env.PI_CODEX_SEARCH_URL",
			"    }",
			`  })), ${String(options.delayMs ?? 0)});`,
			"});",
		].join("\n"),
	);
	chmodSync(binary, 0o755);
};

const subject = { sessionId: "world-session", cellId: "cell-web", depth: 0 };

afterEach(async () => {
	await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Codex conversion Web adapter", () => {
	test("the pinned deep import owns provider, auth, binary, and parsing behavior", async () => {
		const directory = tempDir();
		fakeBinary(directory);
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				StaticAuthorityLive(),
				CodexConversionWebLive({
					getContext: () => context(),
					customRustBinariesDir: directory,
					model: "gpt-search-fixture",
				}),
			),
		);
		runtimes.push(runtime);

		const result = await runtime.runPromise(searchWeb(subject, { query: "Effect 4 release" }));
		expect(result.text).toBe("native-result:Effect 4 release");
		expect(result.details).toEqual({
			output: "native-result:Effect 4 release",
			observed: {
				id: "session-codex-test",
				requestModel: "gpt-search-fixture",
				providerModel: "gpt-5.6-sol",
				authReused: true,
				accountReused: true,
				baseUrl: "https://chatgpt.com/backend-api/codex",
				responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
				searchUrl: "https://chatgpt.com/backend-api/codex/alpha/search",
			},
		});
	});

	test("Effect interruption reaches the package-owned native process signal", async () => {
		const directory = tempDir();
		const readyFile = join(directory, "ready.txt");
		const signalFile = join(directory, "terminated.txt");
		fakeBinary(directory, { delayMs: 30_000, readyFile, signalFile });
		const web = makeCodexConversionWeb({ getContext: () => context(), customRustBinariesDir: directory });
		const controller = new AbortController();
		const pending = Effect.runPromise(web.search({ query: "slow search" }), { signal: controller.signal });
		for (let attempt = 0; attempt < 80 && !existsSync(readyFile); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(readFileSync(readyFile, "utf8")).toBe("ready");
		controller.abort();
		await expect(pending).rejects.toBeDefined();
		for (let attempt = 0; attempt < 40 && !existsSync(signalFile); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(readFileSync(signalFile, "utf8")).toBe("terminated");
	});

	test("authority denial happens before the hidden executor is invoked", async () => {
		let calls = 0;
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				StaticAuthorityLive({ allowedOperations: [] }),
				CodexConversionWebLive({
					getContext: () => context(),
					execute: async () => {
						calls += 1;
						return { text: "must not run", details: {} };
					},
				}),
			),
		);
		runtimes.push(runtime);
		await expect(runtime.runPromise(searchWeb(subject, { query: "denied" }))).rejects.toMatchObject({
			code: "WORLD_ACCESS_DENIED",
			operation: "web.search",
		});
		expect(calls).toBe(0);
	});

	test("executor failures become typed World failures", async () => {
		const web = makeCodexConversionWeb({
			getContext: () => context(),
			execute: async () => {
				throw new Error("provider unavailable");
			},
		});
		await expect(Effect.runPromise(web.search({ query: "failure" }))).rejects.toEqual({
			_tag: "WebSearchError",
			code: "WEB_SEARCH_FAILED",
			message: "provider unavailable",
		});
	});

	test("the adapter stays on the pinned executor seam and never registers web_run", () => {
		expect(CODEX_CONVERSION_WEB_IMPORT).toBe("@howaboua/pi-codex-conversion/dist/tools/web-run/tool.js");
		expect(typeof executeCodexWebSearch).toBe("function");
		const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
		expect(packageJson.dependencies["@howaboua/pi-codex-conversion"]).toBe("3.0.14");
		const adapterSource = readFileSync(join(process.cwd(), "src/world/codex-conversion-web.ts"), "utf8");
		expect(adapterSource).not.toContain("registerWebSearchTool");
		expect(adapterSource).not.toContain("PI_CODEX_ACCESS_TOKEN");
		expect(adapterSource).not.toContain("child_process");
	});
});
