/**
 * Pure layout logic for the `execute` cell renderer.
 *
 * Deliberately free of pi imports so it is unit-testable outside pi's runtime:
 * theme, syntax highlighting, key hints, and width primitives are injected.
 * `render.ts` binds the real implementations.
 */

export interface ExecuteDetails {
	status?: "ok" | "error" | "aborted" | string;
	durationMs?: number;
	errorName?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	errorStack?: string[];
}

export interface ExecuteRenderState {
	code: string;
	details?: ExecuteDetails;
	contentText?: string;
	isPartial: boolean;
	isError: boolean;
	expanded: boolean;
	executionStarted: boolean;
	hasResult: boolean;
}

export type StatusKind = "error" | "aborted" | "running" | "queued" | "done";
export type BgKind = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

export interface RenderDeps {
	fg(color: string, text: string): string;
	getBgAnsi(bg: BgKind): string;
	highlight(line: string): string;
	keyHint(expanded: boolean): string;
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis: string): string;
	wrapTextWithAnsi(text: string, width: number): string[];
	/** Injected for deterministic spinner frames in tests. */
	now?(): number;
}

const OUTPUT_INDENT = "  ";
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

export function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

export function previewLine(code: string): string {
	for (const line of code.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length > 0 && !trimmed.startsWith("//")) return trimmed;
	}
	return "";
}

export function isShellish(line: string): boolean {
	return line.includes("Bun.$`");
}

export function statusKind(state: ExecuteRenderState): StatusKind {
	const status = state.details?.status;
	if (state.isError || status === "error") return "error";
	if (status === "aborted") return "aborted";
	if (!state.isPartial && (status !== undefined || state.hasResult)) return "done";
	if (state.isPartial || state.executionStarted) return "running";
	return "queued";
}

export function backgroundFor(kind: StatusKind): BgKind {
	if (kind === "error" || kind === "aborted") return "toolErrorBg";
	if (kind === "done") return "toolSuccessBg";
	return "toolPendingBg";
}

function marker(state: ExecuteRenderState, deps: RenderDeps): string {
	switch (statusKind(state)) {
		case "error":
			return deps.fg("error", "✗");
		case "aborted":
			return deps.fg("warning", "✗");
		case "done":
			return deps.fg("success", "✓");
		case "running": {
			const now = deps.now?.() ?? Date.now();
			return deps.fg("accent", SPINNER_FRAMES[Math.floor(now / 160) % SPINNER_FRAMES.length]);
		}
		default:
			return deps.fg("muted", "◇");
	}
}

function highlightLine(line: string, deps: RenderDeps): string {
	return isShellish(line) ? deps.fg("accent", line) : deps.highlight(line);
}

export function outputText(state: ExecuteRenderState): string {
	const details = state.details;
	if (details && (details.stdout || details.stderr || details.result)) {
		return [details.stdout, details.stderr, details.result]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n");
	}
	return state.contentText?.trim() ?? "";
}

function topLine(state: ExecuteRenderState, width: number, deps: RenderDeps): string {
	const code = state.code.trimEnd();
	const preview = previewLine(code);
	const language = isShellish(preview) ? "rlm · shell" : "rlm";
	const prefix = `${marker(state, deps)} ${deps.fg("muted", language)}`;

	// Fixed metadata after the preview — these must always survive; the preview
	// absorbs all truncation.
	const suffixParts: string[] = [];

	// Counts settle-only: live-updating them mid-stream jitters the header.
	if (!state.isPartial && statusKind(state) !== "running") {
		const inputLines = code.split("\n").filter((line) => line.trim().length > 0).length;
		const output = outputText(state);
		const outputLines = output ? output.split("\n").length : 0;
		const counts: string[] = [];
		if (inputLines > 0) counts.push(`↑ ${inputLines}`);
		if (outputLines > 0) counts.push(`↓ ${outputLines}`);
		if (counts.length > 0) suffixParts.push(deps.fg("muted", `${counts.join(" ")} lines`));
	}

	const duration = formatDuration(state.details?.durationMs);
	if (duration) suffixParts.push(deps.fg("muted", duration));

	const errorName = !state.isPartial ? state.details?.errorName : undefined;
	if (errorName) suffixParts.push(deps.fg("error", errorName));

	suffixParts.push(deps.keyHint(state.expanded));

	const separator = deps.fg("dim", " · ");
	const separatorWidth = deps.visibleWidth(separator);
	const suffix = suffixParts.join(separator);
	// Budget: total width minus leading space, prefix, suffix, and the two
	// separators around the preview slot.
	const fixed = 1 + deps.visibleWidth(prefix) + separatorWidth + deps.visibleWidth(suffix);
	const previewBudget = Math.max(8, width - fixed - separatorWidth);

	const middle = preview
		? deps.truncateToWidth(highlightLine(preview, deps), previewBudget, "…")
		: !state.executionStarted
			? deps.fg("muted", "waiting for code")
			: "";

	return [prefix, ...(middle ? [middle] : []), suffix].join(separator);
}

function addWrapped(lines: string[], prefix: string, text: string, width: number, deps: RenderDeps): void {
	const available = Math.max(1, width - 1 - deps.visibleWidth(prefix));
	const wrapped = deps.wrapTextWithAnsi(text, available);
	for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
		const linePrefix = index === 0 ? prefix : " ".repeat(deps.visibleWidth(prefix));
		lines.push(deps.truncateToWidth(` ${linePrefix}${line}`, width, ""));
	}
}

function renderCode(state: ExecuteRenderState, lines: string[], width: number, deps: RenderDeps): boolean {
	const code = state.code.trimEnd();
	if (!code) return false;
	lines.push("");
	for (const [index, rawLine] of code.split("\n").entries()) {
		const prefix = index === 0 ? deps.fg("dim", "› ") : deps.fg("dim", "  ");
		addWrapped(lines, prefix, highlightLine(rawLine, deps) || " ", width, deps);
	}
	return true;
}

function renderOutput(
	state: ExecuteRenderState,
	lines: string[],
	width: number,
	hasCode: boolean,
	deps: RenderDeps,
): void {
	const details = state.details;
	let outputStarted = false;
	const startOutput = () => {
		if (outputStarted) return;
		outputStarted = true;
		if (hasCode) lines.push("");
	};

	const sections: Array<{ text: string | undefined; color: string }> = [
		{ text: details?.stdout, color: "toolOutput" },
		{ text: details?.stderr, color: "muted" },
		{ text: details?.result, color: "toolOutput" },
	];
	let renderedText = false;
	for (const { text, color } of sections) {
		if (!text?.trim()) continue;
		startOutput();
		renderedText = true;
		for (const line of text.split("\n")) addWrapped(lines, OUTPUT_INDENT, deps.fg(color, line || " "), width, deps);
	}

	if (!renderedText && !details && state.contentText?.trim()) {
		startOutput();
		renderedText = true;
		const color = state.isError ? "muted" : "toolOutput";
		for (const line of state.contentText.trim().split("\n")) {
			addWrapped(lines, OUTPUT_INDENT, deps.fg(color, line || " "), width, deps);
		}
	}

	if (details?.errorStack && details.errorStack.length > 0) {
		startOutput();
		for (const line of details.errorStack) addWrapped(lines, OUTPUT_INDENT, deps.fg("muted", line || " "), width, deps);
	} else if (!renderedText) {
		startOutput();
		const message = state.isPartial || statusKind(state) === "running" ? "waiting for output..." : "no output";
		addWrapped(lines, OUTPUT_INDENT, deps.fg("muted", message), width, deps);
	}
}

/** Paint the status-matched panel background across the row, surviving inner SGR resets. */
export function paintBackground(line: string, width: number, kind: StatusKind, deps: RenderDeps): string {
	const bgAnsi = deps.getBgAnsi(backgroundFor(kind));
	const padded = line + " ".repeat(Math.max(0, width - deps.visibleWidth(line)));
	const rearmed = padded.replaceAll("\x1b[0m", `\x1b[0m${bgAnsi}`);
	return `${bgAnsi}${rearmed}\x1b[0m`;
}

export function renderExecuteCell(state: ExecuteRenderState, width: number, deps: RenderDeps): string[] {
	const safeWidth = Math.max(1, width);
	const lines = [deps.truncateToWidth(` ${topLine(state, safeWidth, deps)}`, safeWidth, "")];
	if (state.expanded) {
		const hasCode = renderCode(state, lines, safeWidth, deps);
		renderOutput(state, lines, safeWidth, hasCode, deps);
	}
	const kind = statusKind(state);
	return lines.map((line) => paintBackground(line, safeWidth, kind, deps));
}
