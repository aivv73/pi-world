import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Layer, ManagedRuntime, Tracer } from "effect";
import type { HostRequestHandlers } from "../engine/index.js";
import { StaticAuthorityLive } from "../world/authority.js";
import { createWorldHost } from "../world/bridge.js";
import { CodexConversionWebLive, type CodexWebSearchExecutor } from "../world/codex-conversion-web.js";
import { DeterministicShellLive } from "../world/deterministic-shell.js";
import { type PiChildSpawnInput, type PiChildSpec, PiProcessAgentsLive } from "../world/pi-process-agents.js";
import type { WorldRuntime } from "../world/runtime.js";

export interface SessionWorldOptions {
	readonly cwd: string;
	readonly extensionPath: string;
	readonly sessionDir: string;
	readonly sessionId: string;
	readonly defaultModel: string;
	readonly depth: number;
	readonly maxDepth: number;
	readonly getContext: () => ExtensionContext;
	readonly spawnCommand?: (input: PiChildSpawnInput) => PiChildSpec;
	readonly executeWeb?: CodexWebSearchExecutor;
	/** Test/exporter seam; production uses Effect's configured tracer. */
	readonly tracer?: Tracer.Tracer;
}

export interface SessionWorld {
	readonly runtime: WorldRuntime;
	readonly handlers: HostRequestHandlers;
	readonly dispose: () => Promise<void>;
}

/** The World outlives evaluator generations and closes only at session scope. */
export class SessionWorldOwner {
	private world: SessionWorld | undefined;

	constructor(private readonly create: (options: SessionWorldOptions) => SessionWorld = createSessionWorld) {}

	acquire(options: SessionWorldOptions) {
		this.world ??= this.create(options);
		return this.world;
	}

	async shutdown() {
		const world = this.world;
		this.world = undefined;
		await world?.dispose();
	}
}

/** One Effect runtime and scope for one Pi session generation. */
export const createSessionWorld = (options: SessionWorldOptions): SessionWorld => {
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			StaticAuthorityLive({ maxDepth: options.maxDepth }),
			PiProcessAgentsLive({
				cwd: options.cwd,
				extensionPath: options.extensionPath,
				sessionDir: options.sessionDir,
				defaultModel: options.defaultModel,
				depth: options.depth,
				spawnCommand: options.spawnCommand,
			}),
			CodexConversionWebLive({ getContext: options.getContext, execute: options.executeWeb }),
			DeterministicShellLive(),
			...(options.tracer ? [Layer.succeed(Tracer.Tracer)(options.tracer)] : []),
		),
	);
	return {
		runtime,
		handlers: createWorldHost({ runtime, sessionId: options.sessionId, depth: options.depth }).handlers,
		dispose: () => runtime.dispose(),
	};
};
