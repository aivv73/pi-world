/**
 * TUI adapter for the `execute` cell renderer.
 *
 * Binds pi's theme, syntax highlighting, key hints, and width primitives to the
 * pure layout in render-core.ts, which is unit-tested outside pi's runtime.
 */

import { highlightCode, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type FrameRecord, readFrameRecords } from "./frames.js";
import { type BgKind, type ExecuteRenderState, type RenderDeps, renderExecuteCell, statusKind } from "./render-core.js";
import { buildFrameTree, type FrameNode } from "./stack-core.js";

export type { ExecuteDetails, ExecuteRenderState } from "./render-core.js";

// ── frame source ─────────────────────────────────────────────────────────────
// The TUI repaints every animation frame, and every visible cell asks for its
// frames on each paint. One shared throttled read per cwd keeps the cost at
// one directory walk per interval, no matter how many cells are on screen.

const FRAME_READ_INTERVAL_MS = 500;
const recordsCache = new Map<string, { at: number; records: FrameRecord[] }>();

function readRecordsThrottled(cwd: string): FrameRecord[] {
	const cached = recordsCache.get(cwd);
	const now = Date.now();
	if (cached && now - cached.at < FRAME_READ_INTERVAL_MS) return cached.records;
	const records = readFrameRecords(cwd);
	recordsCache.set(cwd, { at: now, records });
	return records;
}

/** The frames a cell spawned, treed by lineage. Bound per component in index.ts. */
export function makeFrameSource(cwd: string, cellId: string): () => FrameNode[] {
	return () => buildFrameTree(readRecordsThrottled(cwd), cellId);
}

/** Fold frame fates into the render version key so status changes repaint. */
function frameKey(nodes: readonly FrameNode[]): string {
	const parts: string[] = [];
	const visit = (node: FrameNode): void => {
		parts.push(`${node.record.rlm_child_id}=${node.record.status}`);
		for (const child of node.children) visit(child);
	};
	for (const node of nodes) visit(node);
	return parts.join(",");
}

function makeDeps(theme: Theme): RenderDeps {
	return {
		fg: (color, text) => theme.fg(color as Parameters<Theme["fg"]>[0], text),
		getBgAnsi: (bg: BgKind) => theme.getBgAnsi(bg),
		highlight: (line) => highlightCode(line, "typescript")[0] ?? line,
		keyHint: (expanded) => keyHint("app.tools.expand", expanded ? "to collapse" : "to expand"),
		visibleWidth,
		truncateToWidth,
		wrapTextWithAnsi,
	};
}

/**
 * The layout of a cell only changes when its state or the spinner frame does,
 * but the TUI repaints on every frame. Rendering from a key of both stops the
 * recompute-per-frame (and with it, flicker on wide panes).
 */
function renderVersion(state: ExecuteRenderState): string {
	const details = state.details ? JSON.stringify(state.details) : "";
	return [
		state.code.length,
		state.contentText?.length ?? 0,
		details.length,
		state.isPartial,
		state.isError,
		state.expanded,
		state.executionStarted,
		state.hasResult,
		// Fold the animation frame in while running so the spinner still turns.
		statusKind(state) === "running" ? Math.floor(Date.now() / 160) % 4 : -1,
		state.frames ? frameKey(state.frames) : "",
		// Frame spinners turn and ages tick while any subagent runs.
		state.frames?.length && frameKey(state.frames).includes("running") ? Math.floor(Date.now() / 1000) : -1,
	].join("|");
}

export class ExecuteCellComponent {
	private readonly deps: RenderDeps;
	private cachedKey = "";
	private cachedWidth = -1;
	private cachedLines?: string[];
	private refreshTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly state: ExecuteRenderState,
		theme: Theme,
		private readonly framesSource?: () => FrameNode[],
		/** pi's per-component redraw request (ToolRenderContext.invalidate). */
		private readonly requestRepaint?: () => void,
	) {
		this.deps = makeDeps(theme);
	}

	invalidate(): void {
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// Refresh before the version key is computed so a status change on disk
		// is a new key, and a repaint, on the next frame.
		if (this.framesSource) this.state.frames = this.framesSource();
		this.scheduleLiveRefresh();
		const key = renderVersion(this.state);
		if (this.cachedLines && this.cachedWidth === width && this.cachedKey === key) {
			return this.cachedLines;
		}
		const lines = renderExecuteCell(this.state, width, this.deps);
		this.cachedKey = key;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	/**
	 * The TUI repaints a settled cell only when asked. While any frame runs,
	 * ask again a second from now — that keeps spinners turning and ages
	 * ticking after the spawning cell itself has finished. The chain stops on
	 * its own: a render that sees no running frames schedules nothing.
	 */
	private scheduleLiveRefresh(): void {
		if (!this.requestRepaint || !this.state.frames?.length) return;
		const live = this.state.frames.some(function hasRunning(node: FrameNode): boolean {
			return node.record.status === "running" || node.children.some(hasRunning);
		});
		if (!live || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this.requestRepaint?.();
		}, 1000);
		this.refreshTimer.unref?.();
	}
}
