import { Layer, ManagedRuntime } from "effect";
import { StaticAuthorityLive, type StaticAuthorityOptions } from "./authority.js";
import {
	Agents,
	type AgentsService,
	Authority,
	type AuthorityService,
	Shell,
	type ShellService,
	Web,
	type WebService,
} from "./services.js";

export interface WorldRuntimeOptions extends StaticAuthorityOptions {
	readonly authority?: AuthorityService;
	readonly agents: AgentsService;
	readonly web: WebService;
	readonly shell: ShellService;
}

export const WorldLive = (options: WorldRuntimeOptions) =>
	Layer.mergeAll(
		options.authority ? Layer.succeed(Authority)(options.authority) : StaticAuthorityLive(options),
		Layer.succeed(Agents)(options.agents),
		Layer.succeed(Web)(options.web),
		Layer.succeed(Shell)(options.shell),
	);

export const makeWorldRuntime = (options: WorldRuntimeOptions) => ManagedRuntime.make(WorldLive(options));
export type WorldRuntime = ReturnType<typeof makeWorldRuntime>;
