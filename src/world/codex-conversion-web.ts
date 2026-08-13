import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeCodexWebSearch } from "@howaboua/pi-codex-conversion/dist/tools/web-run/tool.js";
import { Effect, Layer, Schema } from "effect";
import { WebResultSchema, type WebSearchRequest } from "./domain.js";
import { Web, type WebSearchError, type WebService } from "./services.js";

export const CODEX_CONVERSION_WEB_IMPORT = "@howaboua/pi-codex-conversion/dist/tools/web-run/tool.js";

export type CodexWebSearchExecutor = typeof executeCodexWebSearch;

export interface CodexConversionWebOptions {
	/** Read at invocation time: Pi may change model/auth state during a session. */
	readonly getContext: () => ExtensionContext;
	readonly model?: string | (() => string | undefined);
	readonly customRustBinariesDir?: string;
	/** Test seam only; production uses the pinned package deep import above. */
	readonly execute?: CodexWebSearchExecutor;
}

const webSearchError = (message: string): WebSearchError => ({
	_tag: "WebSearchError",
	code: "WEB_SEARCH_FAILED",
	message,
});

const codexParams = (request: WebSearchRequest): Record<string, unknown> => ({
	search_query: [{ q: request.query }],
});

/**
 * Experimental adapter around the pinned package's executor seam.
 *
 * Auth lookup, provider routing, credential environment construction, bundled
 * binary selection, process execution, parsing, and abort handling all remain
 * inside pi-codex-conversion. Reimplementing any of them here is the spike's
 * stop condition, so this module only maps the World request/result algebra.
 */
export const makeCodexConversionWeb = (options: CodexConversionWebOptions): WebService => ({
	search: (request) => {
		if (request.query.trim().length === 0) {
			return Effect.fail(webSearchError("web search query must not be empty"));
		}
		return Effect.annotateCurrentSpan("world.adapter", "codex-conversion").pipe(
			Effect.andThen(
				Effect.tryPromise({
					try: async (signal) => {
						const result = await (options.execute ?? executeCodexWebSearch)(
							codexParams(request),
							options.getContext(),
							signal,
							{
								model: options.model,
								customRustBinariesDir: options.customRustBinariesDir,
							},
						);
						return Schema.decodeUnknownSync(WebResultSchema)(result);
					},
					catch: (error) => webSearchError(error instanceof Error ? error.message : "Codex web search failed"),
				}),
			),
		);
	},
});

export const CodexConversionWebLive = (options: CodexConversionWebOptions) =>
	Layer.succeed(Web)(makeCodexConversionWeb(options));
