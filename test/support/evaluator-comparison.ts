import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineManager, type EngineOptions, type ExecuteResult } from "../../src/engine/index.js";

export const PI_RLM_BASELINE_COMMIT = "70d45e6";

export interface CompatibleEngineManager {
	readonly execute: EngineManager["execute"];
	readonly snapshotState: EngineManager["snapshotState"];
	readonly restoreState: EngineManager["restoreState"];
	readonly kill: EngineManager["kill"];
}

export interface CompatibleEngineManagerConstructor {
	new (options?: EngineOptions): CompatibleEngineManager;
}

const normalizeExecution = (result: ExecuteResult) => ({
	status: result.status,
	stdout: result.stdout,
	stderr: result.stderr,
	result: result.result,
	error: result.error ? { name: result.error.name, message: result.error.message } : undefined,
});

/** Common subset: World and structured host errors are intentionally additive. */
export const runEvaluatorCompatibilityScenario = async (
	Manager: CompatibleEngineManagerConstructor = EngineManager,
) => {
	const engine = new Manager({ cwd: process.cwd() });
	const cells = [
		"counter = 1",
		"counter += 2; counter",
		"await Promise.resolve(counter * 2)",
		'console.log("stdout-proof"); console.error("stderr-proof"); ({ counter })',
		'stable = 9; throw new TypeError("boom")',
		"stable",
	];
	const executions = [];
	try {
		for (const [index, code] of cells.entries()) {
			executions.push(normalizeExecution(await engine.execute(code, { cellId: `compat-${index}` })));
		}
	} finally {
		await engine.kill();
	}

	const root = mkdtempSync(join(tmpdir(), "pi-world-compat-"));
	const snapshotPath = join(root, "namespace.snapshot");
	const first = new Manager({ cwd: process.cwd(), snapshot: { path: snapshotPath, debounceMs: 999_999 } });
	try {
		const before = normalizeExecution(
			await first.execute('plain = { count: 4, nested: ["x"] }; live = () => plain.count; plain', {
				cellId: "compat-snapshot",
			}),
		);
		const snapshot = await first.snapshotState();
		await first.kill();
		const second = new Manager({ cwd: process.cwd(), snapshot: { path: snapshotPath, debounceMs: 999_999 } });
		try {
			const restore = await second.restoreState();
			const after = normalizeExecution(
				await second.execute("({ plain, live: typeof live })", { cellId: "compat-restore" }),
			);
			return {
				baselineCommit: PI_RLM_BASELINE_COMMIT,
				executions,
				persistence: {
					before,
					snapshot: snapshot && {
						saved: [...snapshot.saved].sort(),
						written: [...snapshot.written].sort(),
						failed: snapshot.failed.map(({ name }) => name).sort(),
					},
					restore: restore && {
						restored: [...restore.restored].sort(),
						deferred: [...restore.deferred].sort(),
						failed: restore.failed.map(({ name }) => name).sort(),
					},
					after,
				},
			};
		} finally {
			await second.kill();
		}
	} finally {
		await first.kill();
		rmSync(root, { recursive: true, force: true });
	}
};
