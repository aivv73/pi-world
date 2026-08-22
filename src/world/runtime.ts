import { Layer, ManagedRuntime } from "effect";
import { StaticAuthorityLive, type StaticAuthorityOptions } from "./authority.js";
import {
	Agents,
	type AgentsService,
	Authority,
	type AuthorityService,
	Shell,
	ShellGrants,
	type ShellService,
	Web,
	type WebService,
} from "./services.js";
import {
	DEFAULT_VIRTUAL_PROFILES,
	makeProfileRegistry,
	makeShellGrants,
	type ShellGrantsService,
} from "./shell-authority.js";

export interface WorldRuntimeOptions extends StaticAuthorityOptions {
	readonly authority?: AuthorityService;
	readonly agents: AgentsService;
	readonly web: WebService;
	readonly shell: ShellService;
	/** Host-owned grant registry; a fresh least-authority registry is the default. */
	readonly grants?: ShellGrantsService;
}

export const WorldLive = (options: WorldRuntimeOptions) =>
	Layer.mergeAll(
		options.authority ? Layer.succeed(Authority)(options.authority) : StaticAuthorityLive(options),
		Layer.succeed(Agents)(options.agents),
		Layer.succeed(Web)(options.web),
		Layer.succeed(Shell)(options.shell),
		Layer.succeed(ShellGrants)(
			options.grants ?? makeShellGrants({ registry: makeProfileRegistry(DEFAULT_VIRTUAL_PROFILES) }),
		),
	);

export const makeWorldRuntime = (options: WorldRuntimeOptions) => ManagedRuntime.make(WorldLive(options));
export type WorldRuntime = ReturnType<typeof makeWorldRuntime>;
