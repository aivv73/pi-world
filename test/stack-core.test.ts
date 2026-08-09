/**
 * The subagent call stack: frame records on disk become stack traces in cells.
 *
 * frames.ts reads what every process in the tree wrote; stack-core.ts is the
 * pure layout — tree building, status summary, and frame lines — tested here
 * with the same injected primitives render-core uses.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FrameRecord, readFrameRecords } from "../src/extension/frames.js";
import {
	buildFrameTree,
	formatFrameAge,
	formatFrameSummary,
	renderFrames,
	summarizeFrames,
} from "../src/extension/stack-core.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (text: string) => text.replace(ANSI, "");

const frameDeps = {
	fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[0m`,
	visibleWidth: (text: string) => stripAnsi(text).length,
	truncateToWidth: (text: string, width: number, ellipsis = "") => {
		const plain = stripAnsi(text);
		return plain.length <= width ? text : stripAnsi(text).slice(0, Math.max(0, width - ellipsis.length)) + ellipsis;
	},
	now: () => Date.parse("2026-08-09T10:05:00Z"),
};

function record(overrides: Partial<FrameRecord> = {}): FrameRecord {
	return {
		rlm_child_id: "sub-a",
		name: "pdf-audit",
		prompt: "audit the pdfs",
		model: "anthropic/haiku",
		status: "running",
		spawned_at: "2026-08-09T10:02:46Z",
		spawn_cell_id: "cell-1",
		...overrides,
	};
}

describe("frame tree", () => {
	test("roots are the cell's own spawns; descendants attach by parent id", () => {
		const records = [
			record({ rlm_child_id: "sub-a" }),
			record({
				rlm_child_id: "sub-b",
				name: "cross-check",
				prompt: "cross-check totals",
				parent_child_id: "sub-a",
				spawn_cell_id: "other-cell",
			}),
			record({ rlm_child_id: "sub-c", name: "unrelated", spawn_cell_id: "some-other-cell" }),
		];
		const tree = buildFrameTree(records, "cell-1");
		expect(tree).toHaveLength(1);
		expect(tree[0].record.rlm_child_id).toBe("sub-a");
		expect(tree[0].children).toHaveLength(1);
		expect(tree[0].children[0].record.name).toBe("cross-check");
	});

	test("siblings order by spawn time", () => {
		const records = [
			record({ rlm_child_id: "sub-late", name: "late", spawned_at: "2026-08-09T10:04:00Z" }),
			record({ rlm_child_id: "sub-early", name: "early", spawned_at: "2026-08-09T10:01:00Z" }),
		];
		const tree = buildFrameTree(records, "cell-1");
		expect(tree.map((node) => node.record.name)).toEqual(["early", "late"]);
	});

	test("a parent cycle cannot hang the tree builder", () => {
		// Corrupt or hand-edited records must degrade, not loop forever.
		const records = [
			record({ rlm_child_id: "sub-a", parent_child_id: "sub-b", spawn_cell_id: "cell-1" }),
			record({ rlm_child_id: "sub-b", parent_child_id: "sub-a", spawn_cell_id: "other" }),
		];
		const tree = buildFrameTree(records, "cell-1");
		expect(tree.length).toBeGreaterThanOrEqual(1);
	});
});

describe("frame summary", () => {
	test("counts every frame in the tree, not just roots", () => {
		const tree = buildFrameTree(
			[
				record({ rlm_child_id: "sub-a", status: "completed", finished_at: "2026-08-09T10:03:00Z" }),
				record({ rlm_child_id: "sub-b", parent_child_id: "sub-a", status: "error", spawn_cell_id: "other" }),
				record({ rlm_child_id: "sub-c", status: "running" }),
			],
			"cell-1",
		);
		expect(summarizeFrames(tree)).toEqual({ total: 3, running: 1, failed: 1, lost: 0 });
	});

	test("the collapsed chip reads count, running, and failures — never glyph strings", () => {
		expect(formatFrameSummary({ total: 3, running: 1, failed: 1, lost: 0 })).toBe("3 subagents · 1 running · 1 failed");
		expect(formatFrameSummary({ total: 1, running: 0, failed: 0, lost: 0 })).toBe("1 subagent");
		expect(formatFrameSummary({ total: 2, running: 2, failed: 0, lost: 0 })).toBe("2 subagents · 2 running");
	});
});

describe("frame lines", () => {
	test("a frame line reads like a stack frame: glyph, name, status, age, spawn site", () => {
		const tree = buildFrameTree(
			[
				record({ rlm_child_id: "sub-a" }),
				record({
					rlm_child_id: "sub-b",
					name: "cross-check",
					prompt: "cross-check totals",
					parent_child_id: "sub-a",
					status: "completed",
					spawned_at: "2026-08-09T10:04:20Z",
					finished_at: "2026-08-09T10:04:32Z",
					spawn_cell_id: "other",
				}),
			],
			"cell-1",
		);
		const lines = renderFrames(tree, 100, frameDeps).map(stripAnsi);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("pdf-audit");
		expect(lines[0]).toContain("running");
		expect(lines[0]).toContain("2m14s");
		expect(lines[0]).toContain('rlm.run("audit the pdfs")');
		// The child is one level deeper and shows its own spawn site.
		expect(lines[1].indexOf("cross-check")).toBeGreaterThan(lines[0].indexOf("pdf-audit"));
		expect(lines[1]).toContain("done");
		expect(lines[1]).toContain("12s");
		expect(lines[1]).toContain('rlm.run("cross-check totals")');
	});

	test("failed frames say so; lost frames are named, not counted as failures", () => {
		const tree = buildFrameTree([record({ status: "error" })], "cell-1");
		expect(stripAnsi(renderFrames(tree, 100, frameDeps)[0])).toContain("failed");
		const lostTree = buildFrameTree([record({ status: "lost" })], "cell-1");
		expect(stripAnsi(renderFrames(lostTree, 100, frameDeps)[0])).toContain("lost");
		expect(summarizeFrames(lostTree)).toEqual({ total: 1, running: 0, failed: 0, lost: 1 });
		expect(formatFrameSummary({ total: 2, running: 0, failed: 0, lost: 1 })).toBe("2 subagents · 1 lost");
	});

	test("every line fits the width; the spawn site absorbs truncation", () => {
		const tree = buildFrameTree(
			[record({ prompt: "an extremely long delegation prompt that cannot possibly fit into a narrow pane" })],
			"cell-1",
		);
		for (const width of [30, 48, 80]) {
			for (const line of renderFrames(tree, width, frameDeps)) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
			}
		}
	});

	test("ages format for human scanning across scales", () => {
		expect(formatFrameAge(12_000)).toBe("12s");
		expect(formatFrameAge(134_000)).toBe("2m14s");
		expect(formatFrameAge(3 * 3600_000 + 120_000)).toBe("3h2m");
	});
});

describe("frame records on disk", () => {
	test("readFrameRecords walks every session's subagent dir under the cwd", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-rlm-frames-"));
		try {
			const dirA = join(cwd, ".pi-rlm", "session-a", "subagents");
			const dirB = join(cwd, ".pi-rlm", "session-b", "subagents");
			mkdirSync(dirA, { recursive: true });
			mkdirSync(dirB, { recursive: true });
			writeFileSync(join(dirA, "sub-1.json"), JSON.stringify(record({ rlm_child_id: "sub-1" })));
			writeFileSync(join(dirB, "sub-2.json"), JSON.stringify(record({ rlm_child_id: "sub-2" })));
			// Session files and outputs share these directories; only records load.
			writeFileSync(join(dirA, "session.jsonl"), "not json frames");
			writeFileSync(join(dirA, "sub-1.output.md"), "output");
			writeFileSync(join(dirB, "corrupt.json"), "{ nope");
			const ids = readFrameRecords(cwd)
				.map((r) => r.rlm_child_id)
				.sort();
			expect(ids).toEqual(["sub-1", "sub-2"]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// A record can outlive its writer: if pi is killed abruptly, the final
	// status write never happens and "running" would be a permanent lie. A
	// running record whose pid is gone reads as lost — a display truth, never
	// written back to disk.
	test("a running record whose process is gone reads as lost", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-rlm-frames-"));
		try {
			const dir = join(cwd, ".pi-rlm", "session", "subagents");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "sub-dead.json"), JSON.stringify(record({ rlm_child_id: "sub-dead", pid: 4_000_000 })));
			writeFileSync(join(dir, "sub-live.json"), JSON.stringify(record({ rlm_child_id: "sub-live", pid: process.pid })));
			const byId = new Map(readFrameRecords(cwd).map((r) => [r.rlm_child_id, r.status]));
			expect(byId.get("sub-dead")).toBe("lost");
			expect(byId.get("sub-live")).toBe("running");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a cwd with no .pi-rlm directory reads as empty, not as an error", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-rlm-frames-"));
		try {
			expect(readFrameRecords(cwd)).toEqual([]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
