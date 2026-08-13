import { Effect } from "effect";
import {
	type AgentHandleData,
	type AgentId,
	type AgentResult,
	type AgentSpawnRequest,
	makeAgentId,
	makeAttemptId,
	type WebResult,
	type WebSearchRequest,
} from "./domain.js";
import type {
	AgentNotFoundError,
	AgentSpawnError,
	AgentsService,
	AgentWaitError,
	AgentWaitTimeoutError,
	WebSearchError,
	WebService,
} from "./services.js";

export type DeterministicAgentEvent =
	| { readonly _tag: "spawned"; readonly agentId: AgentId; readonly task: string }
	| { readonly _tag: "waited"; readonly agentId: AgentId; readonly timeoutMs?: number }
	| { readonly _tag: "cancelled"; readonly agentId: AgentId };

export interface DeterministicAgentsOptions {
	readonly outputs?: Readonly<Record<string, string>>;
	readonly failures?: Readonly<Record<string, string>>;
	readonly waitDelayMs?: number;
}

interface AgentRecord {
	readonly handle: AgentHandleData;
	readonly request: AgentSpawnRequest;
	status: "running" | "completed" | "cancelled";
}

const spawnError = (message: string): AgentSpawnError => ({
	_tag: "AgentSpawnError",
	code: "AGENT_SPAWN_FAILED",
	message,
});

const notFound = (agentId: AgentId): AgentNotFoundError => ({
	_tag: "AgentNotFoundError",
	code: "AGENT_NOT_FOUND",
	agentId,
	message: `agent ${agentId} was not found`,
});

const waitTimeout = (agentId: AgentId, timeoutMs: number): AgentWaitTimeoutError => ({
	_tag: "AgentWaitTimeoutError",
	code: "AGENT_WAIT_TIMEOUT",
	agentId,
	timeoutMs,
	message: `waiting for agent ${agentId} exceeded ${timeoutMs}ms`,
});

export const makeDeterministicAgents = (options: DeterministicAgentsOptions = {}) => {
	const records = new Map<AgentId, AgentRecord>();
	const events: DeterministicAgentEvent[] = [];
	let sequence = 0;

	const service: AgentsService = {
		spawn: (request) =>
			Effect.suspend(() => {
				if (request.task.trim().length === 0) return Effect.fail(spawnError("agent task must not be empty"));
				sequence += 1;
				const handle = {
					agentId: makeAgentId(`agent-test-${sequence}`),
					attemptId: makeAttemptId(`attempt-test-${sequence}`),
				};
				records.set(handle.agentId, { handle, request, status: "running" });
				events.push({ _tag: "spawned", agentId: handle.agentId, task: request.task });
				return Effect.succeed(handle);
			}),
		wait: (request) =>
			Effect.suspend<AgentResult, AgentNotFoundError | AgentWaitTimeoutError | AgentWaitError, never>(() => {
				const record = records.get(request.agentId);
				if (!record) return Effect.fail(notFound(request.agentId));
				events.push({ _tag: "waited", agentId: request.agentId, timeoutMs: request.timeoutMs });
				if (request.timeoutMs !== undefined && request.timeoutMs < (options.waitDelayMs ?? 0)) {
					return Effect.fail(waitTimeout(request.agentId, request.timeoutMs));
				}
				if (record.status === "cancelled") {
					return Effect.succeed<AgentResult>({
						_tag: "cancelled",
						agentId: record.handle.agentId,
						attemptId: record.handle.attemptId,
						reason: "cancelled by test adapter",
					});
				}
				const failure = options.failures?.[record.request.task];
				record.status = "completed";
				if (failure !== undefined) {
					return Effect.succeed<AgentResult>({
						_tag: "failed",
						agentId: record.handle.agentId,
						attemptId: record.handle.attemptId,
						error: failure,
					});
				}
				return Effect.succeed<AgentResult>({
					_tag: "succeeded",
					agentId: record.handle.agentId,
					attemptId: record.handle.attemptId,
					output: options.outputs?.[record.request.task] ?? `completed: ${record.request.task}`,
				});
			}),
		cancel: (agentId) =>
			Effect.suspend(() => {
				const record = records.get(agentId);
				if (!record) return Effect.fail(notFound(agentId));
				if (record.status === "running") {
					record.status = "cancelled";
					events.push({ _tag: "cancelled", agentId });
				}
				return Effect.succeed(undefined);
			}),
	};

	return { service, events };
};

export interface DeterministicWebOptions {
	readonly results?: Readonly<Record<string, WebResult>>;
	readonly failures?: Readonly<Record<string, string>>;
}

export const makeDeterministicWeb = (options: DeterministicWebOptions = {}) => {
	const queries: string[] = [];
	const service: WebService = {
		search: (request: WebSearchRequest) =>
			Effect.suspend(() => {
				if (request.query.trim().length === 0) {
					const error: WebSearchError = {
						_tag: "WebSearchError",
						code: "WEB_SEARCH_FAILED",
						message: "web search query must not be empty",
					};
					return Effect.fail(error);
				}
				queries.push(request.query);
				const failure = options.failures?.[request.query];
				if (failure !== undefined) {
					const error: WebSearchError = {
						_tag: "WebSearchError",
						code: "WEB_SEARCH_FAILED",
						message: failure,
					};
					return Effect.fail(error);
				}
				return Effect.succeed(options.results?.[request.query] ?? { text: `result: ${request.query}` });
			}),
	};

	return { service, queries };
};
