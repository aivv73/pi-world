import { Schema } from "effect";
import { HostRequestError, type HostRequestHandler, type HostRequestHandlers } from "../engine/index.js";
import {
	AgentCancelRequestSchema,
	AgentHandleDataSchema,
	AgentResultSchema,
	AgentSpawnRequestSchema,
	AgentWaitRequestSchema,
	WebResultSchema,
	WebSearchRequestSchema,
	type WorldError,
	WorldErrorSchema,
	type WorldOperation,
	WorldSubjectSchema,
} from "./domain.js";
import type { WorldRuntime } from "./runtime.js";
import { cancelAgent, searchWeb, spawnAgent, waitForAgent } from "./services.js";

export interface WorldBridgeOptions {
	readonly runtime: WorldRuntime;
	readonly sessionId: string;
	readonly depth: number;
}

const invalidRequest = (operation: WorldOperation): WorldError => ({
	_tag: "WorldInvalidRequest",
	code: "WORLD_INVALID_REQUEST",
	operation,
	message: `invalid request for world operation ${operation}`,
});

const internalError = (operation: WorldOperation): WorldError => ({
	_tag: "WorldInternalError",
	code: "WORLD_INTERNAL_ERROR",
	operation,
	message: `world operation ${operation} failed internally`,
});

const boundaryError = (error: WorldError) => new HostRequestError(error.message, { ...error });

const decode = <S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	input: unknown,
	operation: WorldOperation,
): S["Type"] => {
	try {
		return Schema.decodeUnknownSync(schema)(input);
	} catch {
		throw boundaryError(invalidRequest(operation));
	}
};

const worldFailure = (operation: WorldOperation, error: unknown) => {
	try {
		return boundaryError(Schema.decodeUnknownSync(WorldErrorSchema)(error));
	} catch {
		return boundaryError(internalError(operation));
	}
};

const handler =
	(
		options: WorldBridgeOptions,
		operation: WorldOperation,
		run: (
			payload: Record<string, unknown>,
			subject: typeof WorldSubjectSchema.Type,
			signal: AbortSignal | undefined,
		) => Promise<Record<string, unknown>>,
	): HostRequestHandler =>
	async (payload, context) => {
		const subject = decode(
			WorldSubjectSchema,
			{ sessionId: options.sessionId, cellId: context?.cellId, depth: options.depth },
			operation,
		);
		try {
			return await run(payload, subject, context?.signal);
		} catch (error) {
			if (error instanceof HostRequestError) throw error;
			throw worldFailure(operation, error);
		}
	};

/**
 * Schema-validating host boundary for the guest's fixed world facade.
 *
 * Authority is checked by the service operation after decoding and before an
 * adapter runs. The calling cell's signal is passed to Effect so cancelling a
 * cell only withdraws that bridge call; admitted agents remain session-owned.
 */
export const createWorldHost = (options: WorldBridgeOptions): { readonly handlers: HostRequestHandlers } => ({
	handlers: {
		"world.agents.spawn": handler(options, "agents.spawn", async (payload, subject, signal) => {
			const request = decode(AgentSpawnRequestSchema, payload.request, "agents.spawn");
			const result = await options.runtime.runPromise(spawnAgent(subject, request), { signal });
			return decode(AgentHandleDataSchema, result, "agents.spawn");
		}),
		"world.agents.wait": handler(options, "agents.wait", async (payload, subject, signal) => {
			const request = decode(AgentWaitRequestSchema, payload.request, "agents.wait");
			const result = await options.runtime.runPromise(waitForAgent(subject, request), { signal });
			return decode(AgentResultSchema, result, "agents.wait");
		}),
		"world.agents.cancel": handler(options, "agents.cancel", async (payload, subject, signal) => {
			const request = decode(AgentCancelRequestSchema, payload.request, "agents.cancel");
			await options.runtime.runPromise(cancelAgent(subject, request.agentId), { signal });
			return {};
		}),
		"world.web.search": handler(options, "web.search", async (payload, subject, signal) => {
			const request = decode(WebSearchRequestSchema, payload.request, "web.search");
			const result = await options.runtime.runPromise(searchWeb(subject, request), { signal });
			return decode(WebResultSchema, result, "web.search");
		}),
	},
});
