/**
 * Pure layout for the subagent call stack.
 *
 * A subagent is a stack frame: the cell that called rlm.run is frame #0, and
 * each descendant renders one line — glyph, name, status, age, spawn site —
 * indented by depth, so nesting reads like a trace. Pure and dep-injected for
 * the same reason render-core.ts is: testable outside pi's runtime.
 */

import type { FrameRecord } from "./frames.js";

export interface FrameNode {
	record: FrameRecord;
	children: FrameNode[];
}

export interface FrameSummary {
	total: number;
	running: number;
	failed: number;
	/** Writer died before the final status write; distinct from failed. */
	lost: number;
}

/** The slice of RenderDeps frame lines need; render-core's deps satisfy it. */
export interface FrameRenderDeps {
	fg(color: string, text: string): string;
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis: string): string;
	now?(): number;
}

const FRAME_INDENT = "  ";
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

/**
 * Roots are the frames this cell spawned; descendants attach by parent id
 * regardless of which cell inside the child spawned them. Sibling order is
 * spawn order. A cycle in corrupt records degrades to a forest, never a hang.
 */
export function buildFrameTree(records: readonly FrameRecord[], cellId: string): FrameNode[] {
	const nodes = new Map<string, FrameNode>();
	for (const record of records) {
		nodes.set(record.rlm_child_id, { record, children: [] });
	}
	const roots: FrameNode[] = [];
	for (const node of nodes.values()) {
		if (node.record.spawn_cell_id === cellId) {
			roots.push(node);
			continue;
		}
		const parent = node.record.parent_child_id ? nodes.get(node.record.parent_child_id) : undefined;
		if (parent && parent !== node) parent.children.push(node);
	}
	// A frame reachable from a root must appear exactly once even when corrupt
	// records form a cycle; emission (renderFrames) guards against revisits too.
	const bySpawnTime = (a: FrameNode, b: FrameNode) => a.record.spawned_at.localeCompare(b.record.spawned_at);
	for (const node of nodes.values()) node.children.sort(bySpawnTime);
	return roots.sort(bySpawnTime);
}

export function summarizeFrames(nodes: readonly FrameNode[]): FrameSummary {
	const summary: FrameSummary = { total: 0, running: 0, failed: 0, lost: 0 };
	const visit = (node: FrameNode, seen: Set<FrameNode>): void => {
		if (seen.has(node)) return;
		seen.add(node);
		summary.total += 1;
		if (node.record.status === "running") summary.running += 1;
		if (node.record.status === "error") summary.failed += 1;
		if (node.record.status === "lost") summary.lost += 1;
		for (const child of node.children) visit(child, seen);
	};
	const seen = new Set<FrameNode>();
	for (const node of nodes) visit(node, seen);
	return summary;
}

/** Collapsed-header chip: counts, not glyph strings — they stop scanning past a handful. */
export function formatFrameSummary(summary: FrameSummary): string {
	const parts = [`${summary.total} ${summary.total === 1 ? "subagent" : "subagents"}`];
	if (summary.running > 0) parts.push(`${summary.running} running`);
	if (summary.failed > 0) parts.push(`${summary.failed} failed`);
	if (summary.lost > 0) parts.push(`${summary.lost} lost`);
	return parts.join(" · ");
}

/** 12s · 2m14s · 3h2m — coarser units as the age grows, built for scanning. */
export function formatFrameAge(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

function frameAge(record: FrameRecord, now: number): string {
	const spawned = Date.parse(record.spawned_at);
	if (Number.isNaN(spawned)) return "";
	const end = record.finished_at ? Date.parse(record.finished_at) : now;
	return formatFrameAge((Number.isNaN(end) ? now : end) - spawned);
}

function statusGlyph(status: FrameRecord["status"], now: number, deps: FrameRenderDeps): string {
	switch (status) {
		case "running":
			return deps.fg("accent", SPINNER_FRAMES[Math.floor(now / 160) % SPINNER_FRAMES.length]);
		case "completed":
			return deps.fg("success", "✓");
		case "lost":
			return deps.fg("dim", "◌");
		default:
			return deps.fg("error", "✗");
	}
}

function statusWord(status: FrameRecord["status"]): string {
	switch (status) {
		case "running":
			return "running";
		case "completed":
			return "done";
		case "lost":
			return "lost";
		default:
			return "failed";
	}
}

/**
 * One line per frame, depth-first. The fixed parts — glyph, name, status,
 * age — always survive; the spawn site absorbs all truncation, exactly as the
 * preview does in the cell header.
 */
export function renderFrames(nodes: readonly FrameNode[], width: number, deps: FrameRenderDeps): string[] {
	const now = deps.now?.() ?? Date.now();
	const lines: string[] = [];
	const seen = new Set<FrameNode>();
	const emit = (node: FrameNode, depth: number): void => {
		if (seen.has(node)) return;
		seen.add(node);
		const record = node.record;
		const indent = FRAME_INDENT.repeat(depth + 1);
		const fixed = [
			statusGlyph(record.status, now, deps),
			record.name,
			deps.fg(
				record.status === "error" ? "error" : record.status === "lost" ? "dim" : "muted",
				statusWord(record.status),
			),
			deps.fg("muted", frameAge(record, now)),
		].join(" ");
		const spawnSite = `rlm.run(${JSON.stringify(record.prompt)})`;
		const separator = deps.fg("dim", " · ");
		const siteBudget = width - deps.visibleWidth(indent) - deps.visibleWidth(fixed) - deps.visibleWidth(separator);
		const line =
			siteBudget >= 8
				? `${indent}${fixed}${separator}${deps.fg("dim", deps.truncateToWidth(spawnSite, siteBudget, "…"))}`
				: `${indent}${fixed}`;
		lines.push(deps.truncateToWidth(line, width, "…"));
		for (const child of node.children) emit(child, depth + 1);
	};
	for (const node of nodes) emit(node, 0);
	return lines;
}
