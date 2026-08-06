/**
 * Engine lifecycle: revival is part of creating an engine.
 *
 * These pin the defect that lost a live session's namespace. pi tears
 * extensions down on reload unconditionally but only re-emits session_start
 * for extensions that registered UI, commands, a shutdown handler, or an error
 * listener. With revival wired only to session_start, an extension with none of
 * those got the teardown and not the startup: the next tool call built a fresh
 * engine with an empty namespace, and every cell after it worked perfectly
 * while every variable was gone.
 */

import { describe, expect, test } from "bun:test";
import type { RestoreResult } from "../src/engine/index.js";
import { EngineLifecycle, formatEngineResetNotice, type RevivableEngine } from "../src/extension/session-engine.js";

class FakeEngine implements RevivableEngine {
	restoreCalls = 0;
	disposed = false;
	constructor(private readonly result: RestoreResult | null) {}
	async restoreState(): Promise<RestoreResult | null> {
		this.restoreCalls++;
		return this.result;
	}
}

const snapshotWith = (restored: string[], failed: string[] = []): RestoreResult => ({
	path: "/tmp/snap",
	restored,
	failed: failed.map((name) => ({ name, reason: "not serializable" })),
});

function lifecycleOver(results: (RestoreResult | null)[]) {
	const built: FakeEngine[] = [];
	const lifecycle = new EngineLifecycle<FakeEngine>({
		create() {
			const engine = new FakeEngine(results[built.length] ?? null);
			built.push(engine);
			return engine;
		},
		async dispose(engine) {
			engine.disposed = true;
		},
	});
	return { lifecycle, built };
}

describe("engine lifecycle", () => {
	test("an engine built to serve a cell revives the namespace", async () => {
		// The regression: previously only the startup path revived, so an engine
		// created here began empty and nothing said so.
		const { lifecycle, built } = lifecycleOver([snapshotWith(["tmp", "entryPath"])]);
		const { restore, created } = await lifecycle.acquire("cell");
		expect(created).toBe(true);
		expect(built[0].restoreCalls).toBe(1);
		expect(restore?.restored).toEqual(["tmp", "entryPath"]);
	});

	test("a rebuild after shutdown revives again rather than starting empty", async () => {
		// This is the reload sequence exactly: teardown fires, no startup follows,
		// and the next cell is what brings the engine back.
		const { lifecycle, built } = lifecycleOver([snapshotWith(["a"]), snapshotWith(["a", "b"])]);
		await lifecycle.acquire("startup");
		await lifecycle.shutdown();
		expect(built[0].disposed).toBe(true);

		const { restore, created } = await lifecycle.acquire("cell");
		expect(created).toBe(true);
		expect(built).toHaveLength(2);
		expect(restore?.restored).toEqual(["a", "b"]);
	});

	test("the engine is created once and revived once, however many callers ask", async () => {
		const { lifecycle, built } = lifecycleOver([snapshotWith(["x"])]);
		const [first, second, third] = await Promise.all([
			lifecycle.acquire("cell"),
			lifecycle.acquire("cell"),
			lifecycle.acquire("cell"),
		]);
		expect(built).toHaveLength(1);
		expect(built[0].restoreCalls).toBe(1);
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(third.created).toBe(false);
		// Late callers still observe the revived state rather than racing past it.
		expect(second.restore?.restored).toEqual(["x"]);
	});

	test("a failing revival leaves a usable engine rather than propagating", async () => {
		const lifecycle = new EngineLifecycle({
			create: () => ({
				restoreState: async () => {
					throw new Error("snapshot unreadable");
				},
			}),
			dispose: async () => {},
		});
		const { restore } = await lifecycle.acquire("cell");
		expect(restore).toBeNull();
	});
});

describe("engine reset notice", () => {
	test("a cell-origin engine arms the notice; a startup one does not", async () => {
		const startup = lifecycleOver([snapshotWith(["a"])]);
		await startup.lifecycle.acquire("startup");
		// Startup is already announced in the transcript; a second notice is noise.
		expect(startup.lifecycle.takeResetNotice()).toBeUndefined();

		const midSession = lifecycleOver([snapshotWith(["a"])]);
		await midSession.lifecycle.acquire("cell");
		expect(midSession.lifecycle.takeResetNotice()).toContain("<rlm_engine_reset>");
	});

	test("the notice is delivered exactly once", async () => {
		const { lifecycle } = lifecycleOver([snapshotWith(["a"])]);
		await lifecycle.acquire("cell");
		expect(lifecycle.takeResetNotice()).toBeDefined();
		// The next cell must not be told again about a reset it already saw.
		expect(lifecycle.takeResetNotice()).toBeUndefined();
	});

	test("the notice names revived and lost variables", () => {
		const notice = formatEngineResetNotice(snapshotWith(["tmp", "entry"], ["edit", "readJson"]));
		expect(notice).toContain("Revived (2): tmp, entry");
		expect(notice).toContain("Lost (2): edit, readJson");
		expect(notice).toContain("</rlm_engine_reset>");
	});

	test("an empty namespace is stated plainly rather than as an empty list", () => {
		const notice = formatEngineResetNotice(null);
		expect(notice).toContain("namespace is empty");
		expect(notice).not.toContain("Revived (0)");
	});

	test("every notice warns about reuse in shell interpolation", () => {
		// The loss that motivated this surfaced as a stale variable interpolated
		// into a shell command, so the warning travels with the notice itself.
		for (const notice of [formatEngineResetNotice(null), formatEngineResetNotice(snapshotWith(["a"]))]) {
			expect(notice).toContain("shell interpolation");
		}
	});
});
