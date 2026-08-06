/**
 * TUI adapter for the `execute` cell renderer.
 *
 * Binds pi's theme, syntax highlighting, key hints, and width primitives to the
 * pure layout in render-core.ts, which is unit-tested outside pi's runtime.
 */

import { highlightCode, keyHint, type Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { type BgKind, type RenderDeps, renderExecuteCell } from "./render-core.js";

export type { ExecuteDetails, ExecuteRenderState } from "./render-core.js";

import type { ExecuteRenderState } from "./render-core.js";

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

export class ExecuteCellComponent {
	private readonly deps: RenderDeps;

	constructor(
		private readonly state: ExecuteRenderState,
		theme: Theme,
	) {
		this.deps = makeDeps(theme);
	}

	invalidate(): void {}

	render(width: number): string[] {
		return renderExecuteCell(this.state, width, this.deps);
	}
}
