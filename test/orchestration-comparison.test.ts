import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const occurrences = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length;

describe("orchestration bookkeeping comparison", () => {
	test("the World path has one process authority map and no polling registry", () => {
		const world = source("src/world/pi-process-agents.ts");
		const legacy = source("src/extension/subagents.ts");
		expect(occurrences(world, /new Map</g)).toBe(1);
		expect(occurrences(legacy, /new Map</g)).toBeGreaterThan(occurrences(world, /new Map</g));
		expect(world).not.toContain("list_subagents");
		expect(world).not.toContain("setInterval");
	});
});
