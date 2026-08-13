import { Context, Effect } from "effect";
import type {
	AgentHandleData,
	AgentId,
	AgentResult,
	AgentSpawnRequest,
	AgentWaitRequest,
	WebResult,
	WebSearchRequest,
	WorldError,
	WorldOperation,
	WorldSubject,
} from "./domain.js";

export type WorldDenied = Extract<WorldError, { readonly _tag: "WorldDenied" }>;
export type AgentSpawnError = Extract<WorldError, { readonly _tag: "AgentSpawnError" }>;
export type AgentNotFoundError = Extract<WorldError, { readonly _tag: "AgentNotFoundError" }>;
export type AgentWaitTimeoutError = Extract<WorldError, { readonly _tag: "AgentWaitTimeoutError" }>;
export type AgentWaitError = Extract<WorldError, { readonly _tag: "AgentWaitError" }>;
export type AgentCancelError = Extract<WorldError, { readonly _tag: "AgentCancelError" }>;
export type WebSearchError = Extract<WorldError, { readonly _tag: "WebSearchError" }>;

export interface AuthorityService {
	readonly check: (subject: WorldSubject, operation: WorldOperation) => Effect.Effect<void, WorldDenied>;
}

export interface AgentsService {
	readonly spawn: (request: AgentSpawnRequest) => Effect.Effect<AgentHandleData, AgentSpawnError>;
	readonly wait: (
		request: AgentWaitRequest,
	) => Effect.Effect<AgentResult, AgentNotFoundError | AgentWaitTimeoutError | AgentWaitError>;
	readonly cancel: (agentId: AgentId) => Effect.Effect<void, AgentNotFoundError | AgentCancelError>;
}

export interface WebService {
	readonly search: (request: WebSearchRequest) => Effect.Effect<WebResult, WebSearchError>;
}

export const Authority = Context.Service<AuthorityService>("World/Authority");
export const Agents = Context.Service<AgentsService>("World/Agents");
export const Web = Context.Service<WebService>("World/Web");

export const authorize = (subject: WorldSubject, operation: WorldOperation) =>
	Effect.gen(function* () {
		const authority = yield* Authority;
		yield* authority.check(subject, operation);
	});

export const spawnAgent = (subject: WorldSubject, request: AgentSpawnRequest) =>
	Effect.gen(function* () {
		yield* authorize(subject, "agents.spawn");
		const agents = yield* Agents;
		return yield* agents.spawn(request);
	});

export const waitForAgent = (subject: WorldSubject, request: AgentWaitRequest) =>
	Effect.gen(function* () {
		yield* authorize(subject, "agents.wait");
		const agents = yield* Agents;
		return yield* agents.wait(request);
	});

export const cancelAgent = (subject: WorldSubject, agentId: AgentId) =>
	Effect.gen(function* () {
		yield* authorize(subject, "agents.cancel");
		const agents = yield* Agents;
		yield* agents.cancel(agentId);
	});

export const searchWeb = (subject: WorldSubject, request: WebSearchRequest) =>
	Effect.gen(function* () {
		yield* authorize(subject, "web.search");
		const web = yield* Web;
		return yield* web.search(request);
	});
