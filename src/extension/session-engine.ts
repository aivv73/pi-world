/**
 * Engine lifecycle for a pi session: creation, revival, and the reset notice.
 *
 * Kept free of pi imports so the lifecycle is testable directly. The rule it
 * enforces is that **reviving the namespace is part of creating an engine**,
 * never a separate step a caller has to remember.
 *
 * That separation was a real defect. pi tears extensions down on reload
 * unconditionally, but only re-emits session_start when the extension has
 * registered UI, commands, a shutdown handler, or an error listener. An
 * extension with none of those got the teardown and not the startup, so the
 * next tool call quietly built a fresh engine with an empty namespace. Cells
 * kept working perfectly; every variable was simply gone.
 */

import type { RestoreResult } from "../engine/index.js";

/** The part of EngineManager this lifecycle needs; narrowed so tests can fake it. */
export interface RevivableEngine {
	restoreState(): Promise<RestoreResult | null>;
}

export interface EngineLifecycleDeps<E extends RevivableEngine> {
	/** Builds a fresh engine. Called at most once per lifecycle generation. */
	create(): E;
	/** Tears the current engine down, flushing its final snapshot. */
	dispose(engine: E): Promise<void>;
}

/**
 * Why an engine came into existence. `startup` is the expected path and is
 * already announced in the transcript; `cell` means an engine had to be built
 * to serve a tool call, which only happens when the previous one went away
 * mid-session — the case the model needs told about in-band.
 */
export type AcquireOrigin = "startup" | "cell";

export function formatEngineResetNotice(restore: RestoreResult | null): string {
	const lines = ["<rlm_engine_reset>"];
	if (!restore || restore.restored.length === 0) {
		lines.push(
			"The evaluator restarted and its namespace is empty; no snapshot was available to revive.",
			"Every variable from earlier in this session is gone. Rebuild what you need before using it.",
		);
	} else {
		lines.push(
			"The evaluator restarted. Its namespace was rebuilt from the last snapshot, so it may be behind.",
			`Revived (${restore.restored.length}): ${restore.restored.join(", ")}`,
		);
		if (restore.failed.length > 0) {
			lines.push(
				`Lost (${restore.failed.length}): ${restore.failed.map((f) => f.name).join(", ")}`,
				"Functions, classes, and live handles cannot be snapshotted; redefine them.",
			);
		}
		lines.push("Anything defined after the last snapshot is also gone.");
	}
	lines.push("Re-verify a variable before reusing it, especially inside shell interpolation.", "</rlm_engine_reset>");
	return lines.join("\n");
}

export class EngineLifecycle<E extends RevivableEngine> {
	private engine?: E;
	private revival?: Promise<RestoreResult | null>;
	private pendingNotice?: string;

	constructor(private readonly deps: EngineLifecycleDeps<E>) {}

	/**
	 * The live engine, built and revived if it does not exist yet.
	 *
	 * Revival is awaited here rather than left to a lifecycle event, so no
	 * caller can observe a namespace that was never given the chance to come
	 * back. An engine built to serve a cell also arms the reset notice.
	 */
	async acquire(origin: AcquireOrigin): Promise<{ engine: E; restore: RestoreResult | null; created: boolean }> {
		if (this.engine) {
			// Still awaited: a concurrent caller must not race ahead of revival.
			return { engine: this.engine, restore: await this.revival!, created: false };
		}
		const engine = this.deps.create();
		this.engine = engine;
		this.revival = engine.restoreState().catch(() => null);
		const restore = await this.revival;
		if (origin === "cell") this.pendingNotice = formatEngineResetNotice(restore);
		return { engine, restore, created: true };
	}

	/** Returns the pending reset notice exactly once, then clears it. */
	takeResetNotice(): string | undefined {
		const notice = this.pendingNotice;
		this.pendingNotice = undefined;
		return notice;
	}

	async shutdown(): Promise<void> {
		const engine = this.engine;
		this.engine = undefined;
		this.revival = undefined;
		this.pendingNotice = undefined;
		if (engine) await this.deps.dispose(engine);
	}
}
