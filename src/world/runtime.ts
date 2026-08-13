import { Layer, ManagedRuntime } from "effect";
import { StaticAuthorityLive, type StaticAuthorityOptions } from "./authority.js";
import { Agents, type AgentsService, Authority, type AuthorityService, Web, type WebService } from "./services.js";

export interface WorldRuntimeOptions extends StaticAuthorityOptions {
	readonly authority?: AuthorityService;
	readonly agents: AgentsService;
	readonly web: WebService;
}

export const WorldLive = (options: WorldRuntimeOptions) =>
	Layer.mergeAll(
		options.authority ? Layer.succeed(Authority)(options.authority) : StaticAuthorityLive(options),
		Layer.succeed(Agents)(options.agents),
		Layer.succeed(Web)(options.web),
	);

export const makeWorldRuntime = (options: WorldRuntimeOptions) => ManagedRuntime.make(WorldLive(options));
