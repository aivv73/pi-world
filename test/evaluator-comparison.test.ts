import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import baseline from "./fixtures/pi-rlm-0.4.0-evaluator.json";
import {
	type CompatibleEngineManagerConstructor,
	PI_RLM_BASELINE_COMMIT,
	runEvaluatorCompatibilityScenario,
} from "./support/evaluator-comparison.js";

const normalizeJson = (value: unknown) => JSON.parse(JSON.stringify(value));

// The archive is git archive 70d45e6 src/engine, not a fork-side reimplementation.
// Both engines execute this exact script; only durations, paths, and stacks are omitted.
describe("pi-rlm 0.4.0 evaluator comparison", () => {
	test("the baseline and fork transcripts have zero unexpected differences", async () => {
		expect(PI_RLM_BASELINE_COMMIT).toBe("70d45e6");
		const root = mkdtempSync(join(tmpdir(), "pi-rlm-0.4.0-source-"));
		try {
			const archive = join(process.cwd(), "test/fixtures/pi-rlm-0.4.0-engine.tar.gz");
			const extraction = Bun.spawn(["tar", "-xzf", archive, "-C", root], { stdout: "pipe", stderr: "pipe" });
			expect(await extraction.exited).toBe(0);
			symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
			const loaded: unknown = await import(pathToFileURL(join(root, "src/engine/index.ts")).href);
			if (typeof loaded !== "object" || loaded === null || !("EngineManager" in loaded)) {
				throw new Error("pi-rlm baseline archive does not export EngineManager");
			}
			const BaselineEngine = loaded.EngineManager as CompatibleEngineManagerConstructor;
			const baselineActual = await runEvaluatorCompatibilityScenario(BaselineEngine);
			const forkActual = await runEvaluatorCompatibilityScenario();
			expect(normalizeJson(baselineActual)).toEqual(baseline);
			expect(normalizeJson(forkActual)).toEqual(baseline);
			expect(normalizeJson(forkActual)).toEqual(normalizeJson(baselineActual));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
