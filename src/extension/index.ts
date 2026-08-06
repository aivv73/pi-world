/**
 * pi-rlm: RLM engine for pi.
 *
 * A single LLM-facing tool, `execute`, running TypeScript in a persistent Bun
 * evaluator. Everything else — shell, files, subagents, host callbacks — is
 * expressed as code inside that tool rather than as more tools, which is what
 * lets capabilities grow without changing the interface the model sees.
 */

import { basename, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { EngineBusyError, EngineManager } from "../engine/index.js";
import { buildRlmTsPrompt } from "./prompt.js";
import { ExecuteCellComponent, type ExecuteDetails, type ExecuteRenderState } from "./render.js";
import { createSubagentHost, type SubagentHost } from "./subagents.js";

const executeSchema = Type.Object({
	code: Type.String({
		description: "TypeScript to execute in the persistent Bun evaluator.",
	}),
});

function syncRenderState(
	state: Partial<ExecuteRenderState>,
	context: {
		args?: { code?: string };
		isPartial: boolean;
		isError: boolean;
		expanded: boolean;
		executionStarted: boolean;
	},
): ExecuteRenderState {
	state.code = context.args?.code ?? state.code ?? "";
	state.isPartial = context.isPartial;
	state.isError = context.isError;
	state.expanded = context.expanded;
	state.executionStarted = context.executionStarted;
	state.hasResult = state.hasResult ?? false;
	return state as ExecuteRenderState;
}

/** Stack lines kept when surfacing a cell error to the model. */
const ERROR_STACK_LINES = 10;

const DEFAULT_SUBAGENT_MODEL = process.env.PI_RLM_SUBAGENT_MODEL ?? "anthropic/haiku";
const DEPTH = Number(process.env.PI_RLM_DEPTH ?? "0");
const MAX_DEPTH = Number(process.env.PI_RLM_MAX_DEPTH ?? "2");

export default function (pi: ExtensionAPI) {
	let engine: EngineManager | undefined;
	let subagents: SubagentHost | undefined;

	function getEngine(cwd: string, sessionFile: string | undefined): EngineManager {
		if (engine) return engine;
		const sessionKey = sessionFile ? basename(sessionFile).replace(/\.jsonl$/, "") : undefined;
		const stateDir = join(cwd, ".pi-rlm", sessionKey ?? "ephemeral");
		subagents = createSubagentHost({
			cwd,
			subagentDir: join(stateDir, "subagents"),
			defaultModel: DEFAULT_SUBAGENT_MODEL,
			depth: DEPTH,
			maxDepth: MAX_DEPTH,
		});
		engine = new EngineManager({
			cwd,
			hostHandlers: subagents.handlers,
			// A snapshot is keyed to a session file; an ephemeral session has none
			// to key it to, so its namespace lives and dies with the process.
			snapshot: sessionKey ? { path: join(stateDir, "namespace.snapshot") } : undefined,
		});
		return engine;
	}

	// Replace pi's default prompt wholesale. It describes read, bash, and edit
	// tools that this configuration does not register, and a prompt that
	// advertises absent tools is worse than no prompt at all.
	pi.on("before_agent_start", async (event, ctx) => {
		const options = (event as { systemPromptOptions?: { contextFiles?: Array<{ path: string; content: string }> } })
			.systemPromptOptions;
		return {
			systemPrompt: buildRlmTsPrompt({
				cwd: ctx.cwd,
				messagesPath: ctx.sessionManager.getSessionFile() ?? undefined,
				depth: DEPTH,
				allowRecursion: DEPTH < MAX_DEPTH,
				contextFiles: options?.contextFiles,
			}),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		// Revive a previous run's namespace before the first cell.
		const m = getEngine(ctx.cwd, ctx.sessionManager.getSessionFile());
		const restore = await m.restoreState();
		if (restore && restore.restored.length > 0) {
			pi.sendMessage({
				customType: "pi-rlm-restore",
				content: `Revived ${restore.restored.length} variable(s) from the previous run: ${restore.restored.join(", ")}${
					restore.failed.length > 0 ? `. Failed: ${restore.failed.map((f) => f.name).join(", ")}` : ""
				}`,
				display: true,
			});
		}
	});

	pi.on("session_shutdown", async () => {
		subagents?.killAll();
		await engine?.dispose();
		engine = undefined;
		subagents = undefined;
	});

	pi.registerTool<typeof executeSchema, ExecuteDetails, Partial<ExecuteRenderState>>({
		name: "execute",
		label: "execute",
		description:
			"Execute TypeScript in a persistent Bun evaluator. Variables, imports, and loaded data persist across calls. " +
			"Top-level await works. Shell: const out = await Bun.$`cmd`.quiet(); out.stdout.toString(). " +
			"Subagents: await rlm.run(prompt) returns an admission handle; the child's answer lands in handle.output_file. " +
			"The final expression of the cell is returned as the result.",
		parameters: executeSchema,
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = syncRenderState(context.state, { ...context, args });
			return new ExecuteCellComponent(state, theme);
		},
		renderResult(result, options, _theme, context) {
			const state = syncRenderState(context.state, context);
			state.hasResult = true;
			state.isPartial = options.isPartial;
			state.expanded = options.expanded;
			state.details = (result.details as ExecuteDetails | undefined) ?? state.details;
			state.contentText = result.content
				?.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			// The call slot renders the whole cell; the result slot contributes nothing.
			return { render: () => [], invalidate: () => {} };
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const m = getEngine(ctx?.cwd ?? process.cwd(), ctx?.sessionManager?.getSessionFile?.());
			try {
				// Accumulate: partial updates must only ever grow, or the TUI row height
				// oscillates with each replacing chunk (visible as jumping).
				let streamed = "";
				const r = await m.execute(params.code, {
					signal,
					onStream: (chunk) => {
						streamed += chunk;
						onUpdate?.({ content: [{ type: "text", text: streamed }], details: {} });
					},
				});
				// Result text mirrors the engine's channels in a stable order.
				const sections = [r.stdout, r.stderr, r.result];
				if (r.status === "error" && r.error) {
					sections.push(
						[`${r.error.name}: ${r.error.message}`, ...r.error.stack.slice(0, ERROR_STACK_LINES)].join("\n"),
					);
				}
				if (r.status === "aborted") sections.push("[cell aborted]");
				const text = sections.filter((section) => section !== undefined && section !== "").join("\n");

				const details: ExecuteDetails = {
					status: r.status,
					durationMs: r.durationMs,
					errorName: r.error?.name,
					stdout: r.stdout || undefined,
					stderr: r.stderr || undefined,
					result: r.result,
					errorStack: r.error
						? [`${r.error.name}: ${r.error.message}`, ...r.error.stack.slice(0, ERROR_STACK_LINES)]
						: undefined,
				};
				const result = {
					content: [{ type: "text" as const, text: text || "(no output)" }],
					details,
				};
				if (r.status === "error") throw new Error(result.content[0].text);
				return result;
			} catch (error) {
				if (error instanceof EngineBusyError) {
					throw new Error(
						"The evaluator is still wedged by a previously interrupted cell. State was snapshotted; the engine must be restarted.",
					);
				}
				throw error;
			}
		},
	});
}
