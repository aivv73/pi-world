import { Schema } from "effect";
import { HostRequestError, type HostRequestHandler, type HostRequestHandlers } from "../engine/index.js";
import type { PrincipalId } from "./domain.js";
import {
	AgentCancelRequestSchema,
	AgentHandleDataSchema,
	AgentResultSchema,
	AgentSpawnRequestSchema,
	AgentWaitRequestSchema,
	isShellOperation,
	ShellAttachRequestSchema,
	ShellCancelRequestSchema,
	ShellExecutionHandleDataSchema,
	ShellTerminalResultSchema,
	ShellWaitRequestSchema,
	VirtualShellExecRequestSchema,
	WebResultSchema,
	WebSearchRequestSchema,
	type WorldError,
	WorldErrorSchema,
	type WorldOperation,
	WorldSubjectSchema,
} from "./domain.js";
import type { WorldRuntime } from "./runtime.js";
import {
	attachShellExecution,
	cancelAgent,
	cancelShellExecution,
	executeVirtualShell,
	searchWeb,
	spawnAgent,
	waitForAgent,
	waitForShellExecution,
} from "./services.js";

export interface WorldBridgeOptions {
	readonly runtime: WorldRuntime;
	readonly sessionId: string;
	readonly depth: number;
	/** Host-established principal for this session root; never guest-supplied. */
	readonly principalId: PrincipalId;
}

const invalidRequest = (operation: WorldOperation): WorldError =>
	isShellOperation(operation)
		? {
				_tag: "ShellInvalidRequest",
				code: "SHELL_INVALID_REQUEST",
				operation,
				message: "invalid Virtual Shell execution request",
			}
		: {
				_tag: "WorldInvalidRequest",
				code: "WORLD_INVALID_REQUEST",
				operation,
				message: `invalid request for world operation ${operation}`,
			};

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
	strict = false,
): S["Type"] => {
	try {
		return Schema.decodeUnknownSync(schema, strict ? { onExcessProperty: "error" } : undefined)(input);
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
			{
				sessionId: options.sessionId,
				cellId: context?.cellId,
				depth: options.depth,
				principalId: options.principalId,
			},
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
			// Strict: a guest cannot smuggle grants, lineage, or principal
			// identity through the spawn payload.
			const request = decode(AgentSpawnRequestSchema, payload.request, "agents.spawn", true);
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
		"world.shell.virtual.exec": handler(options, "shell.virtual.exec", async (payload, subject, signal) => {
			const request = decode(VirtualShellExecRequestSchema, payload.request, "shell.virtual.exec", true);
			const result = await options.runtime.runPromise(executeVirtualShell(subject, request), { signal });
			return decode(ShellExecutionHandleDataSchema, result, "shell.virtual.exec");
		}),
		"world.shell.wait": handler(options, "shell.wait", async (payload, subject, signal) => {
			const request = decode(ShellWaitRequestSchema, payload.request, "shell.wait", true);
			const result = await options.runtime.runPromise(waitForShellExecution(subject, request), { signal });
			return decode(ShellTerminalResultSchema, result, "shell.wait");
		}),
		"world.shell.cancel": handler(options, "shell.cancel", async (payload, subject, signal) => {
			const request = decode(ShellCancelRequestSchema, payload.request, "shell.cancel", true);
			await options.runtime.runPromise(cancelShellExecution(subject, request), { signal });
			return {};
		}),
		"world.shell.attach": handler(options, "shell.attach", async (payload, subject, signal) => {
			const request = decode(ShellAttachRequestSchema, payload.request, "shell.attach", true);
			const result = await options.runtime.runPromise(attachShellExecution(subject, request), { signal });
			return decode(ShellExecutionHandleDataSchema, result, "shell.attach");
		}),
	},
});
