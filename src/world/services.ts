import { Context, Effect } from "effect";
import type {
	AgentHandleData,
	AgentId,
	AgentResult,
	AgentSpawnRequest,
	AgentWaitRequest,
	ShellAttachRequest,
	ShellCancelRequest,
	ShellExecutionHandleData,
	ShellTerminalResult,
	ShellWaitRequest,
	VirtualShellExecRequest,
	WebResult,
	WebSearchRequest,
	WorldError,
	WorldOperation,
	WorldSubject,
} from "./domain.js";
import { opaqueTraceId, WORLD_SPANS, withPrivacySafeSpan } from "./tracing.js";

export type WorldDenied = Extract<WorldError, { readonly _tag: "WorldDenied" }>;
export type ShellAuthorityDenied = Extract<WorldError, { readonly _tag: "ShellAuthorityDenied" }>;
export type ShellExecutionNotFound = Extract<WorldError, { readonly _tag: "ShellExecutionNotFound" }>;
export type ShellWaitTimeoutError = Extract<WorldError, { readonly _tag: "ShellWaitTimeoutError" }>;
export type AuthorityDenied = WorldDenied | ShellAuthorityDenied;
export type AgentSpawnError = Extract<WorldError, { readonly _tag: "AgentSpawnError" }>;
export type AgentNotFoundError = Extract<WorldError, { readonly _tag: "AgentNotFoundError" }>;
export type AgentWaitTimeoutError = Extract<WorldError, { readonly _tag: "AgentWaitTimeoutError" }>;
export type AgentWaitError = Extract<WorldError, { readonly _tag: "AgentWaitError" }>;
export type AgentCancelError = Extract<WorldError, { readonly _tag: "AgentCancelError" }>;
export type WebSearchError = Extract<WorldError, { readonly _tag: "WebSearchError" }>;

export interface AuthorityService {
	readonly check: (subject: WorldSubject, operation: WorldOperation) => Effect.Effect<void, AuthorityDenied>;
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

export interface ShellService {
	readonly virtualExec: (
		request: VirtualShellExecRequest,
		owner: WorldSubject,
	) => Effect.Effect<ShellExecutionHandleData>;
	readonly wait: (
		request: ShellWaitRequest,
		subject: WorldSubject,
	) => Effect.Effect<ShellTerminalResult, ShellExecutionNotFound | ShellWaitTimeoutError>;
	// Cancellation is idempotent: repeating it on a terminal execution still
	// succeeds, so awaited cancellations and waits converge on the one
	// retained terminal result.
	readonly cancel: (request: ShellCancelRequest, subject: WorldSubject) => Effect.Effect<void, ShellExecutionNotFound>;
	// Exact-ID attachment is the only handle-recovery path: no listing, no
	// search, no broad status — and every refusal stays indistinguishable.
	readonly attach: (
		request: ShellAttachRequest,
		subject: WorldSubject,
	) => Effect.Effect<ShellExecutionHandleData, ShellExecutionNotFound>;
}

export const Authority = Context.Service<AuthorityService>("World/Authority");
export const Agents = Context.Service<AgentsService>("World/Agents");
export const Web = Context.Service<WebService>("World/Web");
export const Shell = Context.Service<ShellService>("World/Shell");

export const authorize = (subject: WorldSubject, operation: WorldOperation) =>
	Effect.gen(function* () {
		const authority = yield* Authority;
		yield* authority.check(subject, operation);
	});

const errorCode = (error: unknown) =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;

const traceEffect = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>, attributes: Record<string, unknown>) =>
	withPrivacySafeSpan(
		name,
		effect.pipe(
			Effect.tap(() => Effect.annotateCurrentSpan("world.outcome", "succeeded")),
			Effect.tapError((error) => {
				const code = errorCode(error);
				return Effect.annotateCurrentSpan({
					"world.outcome": "failed",
					...(code ? { "world.error_code": code } : {}),
				});
			}),
		),
		attributes,
	);

const tracedOperation = <A, E, R>(
	subject: WorldSubject,
	operation: WorldOperation,
	name: string,
	effect: Effect.Effect<A, E, R>,
	attributes: Record<string, unknown> = {},
) =>
	traceEffect(WORLD_SPANS.coordinator, traceEffect(name, effect, attributes), {
		"world.operation": operation,
		"world.depth": subject.depth,
	});

export const spawnAgent = (subject: WorldSubject, request: AgentSpawnRequest) =>
	tracedOperation(
		subject,
		"agents.spawn",
		WORLD_SPANS.agentSpawn,
		Effect.gen(function* () {
			yield* authorize(subject, "agents.spawn");
			const agents = yield* Agents;
			return yield* agents.spawn(request);
		}),
	);

export const waitForAgent = (subject: WorldSubject, request: AgentWaitRequest) =>
	tracedOperation(
		subject,
		"agents.wait",
		WORLD_SPANS.agentWait,
		Effect.gen(function* () {
			yield* authorize(subject, "agents.wait");
			const agents = yield* Agents;
			return yield* agents.wait(request);
		}),
		{
			"agent.id": opaqueTraceId(request.agentId),
			...(request.timeoutMs === undefined ? {} : { "world.timeout_ms": request.timeoutMs }),
		},
	);

export const cancelAgent = (subject: WorldSubject, agentId: AgentId) =>
	tracedOperation(
		subject,
		"agents.cancel",
		WORLD_SPANS.agentCancel,
		Effect.gen(function* () {
			yield* authorize(subject, "agents.cancel");
			const agents = yield* Agents;
			yield* agents.cancel(agentId);
		}),
		{ "agent.id": opaqueTraceId(agentId), "world.cancel_reason": "caller" },
	);

export const searchWeb = (subject: WorldSubject, request: WebSearchRequest) =>
	tracedOperation(
		subject,
		"web.search",
		WORLD_SPANS.webSearch,
		Effect.gen(function* () {
			yield* authorize(subject, "web.search");
			const web = yield* Web;
			return yield* web.search(request);
		}),
	);

export const executeVirtualShell = (subject: WorldSubject, request: VirtualShellExecRequest) =>
	tracedOperation(
		subject,
		"shell.virtual.exec",
		WORLD_SPANS.shellVirtualExec,
		Effect.gen(function* () {
			yield* authorize(subject, "shell.virtual.exec");
			const shell = yield* Shell;
			return yield* shell.virtualExec(request, subject);
		}),
		{ "world.adapter": "deterministic-shell" },
	);

export const waitForShellExecution = (subject: WorldSubject, request: ShellWaitRequest) =>
	tracedOperation(
		subject,
		"shell.wait",
		WORLD_SPANS.shellWait,
		Effect.gen(function* () {
			yield* authorize(subject, "shell.wait");
			const shell = yield* Shell;
			return yield* shell.wait(request, subject);
		}),
		{
			"world.adapter": "deterministic-shell",
			"shell.execution_id": opaqueTraceId(request.executionId),
			...(request.timeoutMs === undefined ? {} : { "world.timeout_ms": request.timeoutMs }),
		},
	);

export const cancelShellExecution = (subject: WorldSubject, request: ShellCancelRequest) =>
	tracedOperation(
		subject,
		"shell.cancel",
		WORLD_SPANS.shellCancel,
		Effect.gen(function* () {
			yield* authorize(subject, "shell.cancel");
			const shell = yield* Shell;
			yield* shell.cancel(request, subject);
		}),
		{
			"world.adapter": "deterministic-shell",
			"shell.execution_id": opaqueTraceId(request.executionId),
			"world.cancel_reason": "caller",
		},
	);

export const attachShellExecution = (subject: WorldSubject, request: ShellAttachRequest) =>
	tracedOperation(
		subject,
		"shell.attach",
		WORLD_SPANS.shellAttach,
		Effect.gen(function* () {
			yield* authorize(subject, "shell.attach");
			const shell = yield* Shell;
			return yield* shell.attach(request, subject);
		}),
		{ "world.adapter": "deterministic-shell", "shell.execution_id": opaqueTraceId(request.executionId) },
	);
