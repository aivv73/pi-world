import { Schema } from "effect";

export const AgentIdSchema = Schema.String.pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentIdSchema.Type;

export const AttemptIdSchema = Schema.String.pipe(Schema.brand("AttemptId"));
export type AttemptId = typeof AttemptIdSchema.Type;

export const makeAgentId = (value: string) => Schema.decodeUnknownSync(AgentIdSchema)(value);
export const makeAttemptId = (value: string) => Schema.decodeUnknownSync(AttemptIdSchema)(value);

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<JsonValue>
	| { readonly [key: string]: JsonValue };

export const JsonValueSchema: Schema.Decoder<JsonValue> = Schema.suspend(() =>
	Schema.Union([
		Schema.Null,
		Schema.Boolean,
		Schema.Number,
		Schema.String,
		Schema.Array(JsonValueSchema),
		Schema.Record(Schema.String, JsonValueSchema),
	]),
);

export const WorldSubjectSchema = Schema.Struct({
	sessionId: Schema.String,
	cellId: Schema.optionalKey(Schema.String),
	depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type WorldSubject = typeof WorldSubjectSchema.Type;

export const WorldOperationSchema = Schema.Literals([
	"agents.spawn",
	"agents.wait",
	"agents.cancel",
	"web.search",
] as const);
export type WorldOperation = typeof WorldOperationSchema.Type;

const WorldInvalidRequestSchema = Schema.Struct({
	_tag: Schema.Literal("WorldInvalidRequest"),
	code: Schema.Literal("WORLD_INVALID_REQUEST"),
	operation: WorldOperationSchema,
	message: Schema.String,
});

const WorldInternalErrorSchema = Schema.Struct({
	_tag: Schema.Literal("WorldInternalError"),
	code: Schema.Literal("WORLD_INTERNAL_ERROR"),
	operation: WorldOperationSchema,
	message: Schema.String,
});

const WorldDeniedSchema = Schema.Struct({
	_tag: Schema.Literal("WorldDenied"),
	code: Schema.Literal("WORLD_ACCESS_DENIED"),
	operation: WorldOperationSchema,
	message: Schema.String,
});

const AgentSpawnErrorSchema = Schema.Struct({
	_tag: Schema.Literal("AgentSpawnError"),
	code: Schema.Literal("AGENT_SPAWN_FAILED"),
	message: Schema.String,
});

const AgentNotFoundErrorSchema = Schema.Struct({
	_tag: Schema.Literal("AgentNotFoundError"),
	code: Schema.Literal("AGENT_NOT_FOUND"),
	agentId: AgentIdSchema,
	message: Schema.String,
});

const AgentWaitTimeoutErrorSchema = Schema.Struct({
	_tag: Schema.Literal("AgentWaitTimeoutError"),
	code: Schema.Literal("AGENT_WAIT_TIMEOUT"),
	agentId: AgentIdSchema,
	timeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	message: Schema.String,
});

const AgentWaitErrorSchema = Schema.Struct({
	_tag: Schema.Literal("AgentWaitError"),
	code: Schema.Literal("AGENT_WAIT_FAILED"),
	agentId: AgentIdSchema,
	message: Schema.String,
});

const AgentCancelErrorSchema = Schema.Struct({
	_tag: Schema.Literal("AgentCancelError"),
	code: Schema.Literal("AGENT_CANCEL_FAILED"),
	agentId: AgentIdSchema,
	message: Schema.String,
});

const WebSearchErrorSchema = Schema.Struct({
	_tag: Schema.Literal("WebSearchError"),
	code: Schema.Literal("WEB_SEARCH_FAILED"),
	message: Schema.String,
});

export const WorldErrorSchema = Schema.Union([
	WorldInvalidRequestSchema,
	WorldInternalErrorSchema,
	WorldDeniedSchema,
	AgentSpawnErrorSchema,
	AgentNotFoundErrorSchema,
	AgentWaitTimeoutErrorSchema,
	AgentWaitErrorSchema,
	AgentCancelErrorSchema,
	WebSearchErrorSchema,
]);
export type WorldError = typeof WorldErrorSchema.Type;

export const AgentSpawnRequestSchema = Schema.Struct({
	task: Schema.String,
	model: Schema.optionalKey(Schema.String),
	timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type AgentSpawnRequest = typeof AgentSpawnRequestSchema.Type;

export const AgentWaitRequestSchema = Schema.Struct({
	agentId: AgentIdSchema,
	timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type AgentWaitRequest = typeof AgentWaitRequestSchema.Type;

export const AgentCancelRequestSchema = Schema.Struct({
	agentId: AgentIdSchema,
});
export type AgentCancelRequest = typeof AgentCancelRequestSchema.Type;

export const AgentHandleDataSchema = Schema.Struct({
	agentId: AgentIdSchema,
	attemptId: AttemptIdSchema,
});
export type AgentHandleData = typeof AgentHandleDataSchema.Type;

const AgentSucceededSchema = Schema.Struct({
	_tag: Schema.Literal("succeeded"),
	agentId: AgentIdSchema,
	attemptId: AttemptIdSchema,
	output: Schema.String,
});

const AgentFailedSchema = Schema.Struct({
	_tag: Schema.Literal("failed"),
	agentId: AgentIdSchema,
	attemptId: AttemptIdSchema,
	error: Schema.String,
});

const AgentCancelledSchema = Schema.Struct({
	_tag: Schema.Literal("cancelled"),
	agentId: AgentIdSchema,
	attemptId: AttemptIdSchema,
	reason: Schema.optionalKey(Schema.String),
});

const AgentTimedOutSchema = Schema.Struct({
	_tag: Schema.Literal("timed_out"),
	agentId: AgentIdSchema,
	attemptId: AttemptIdSchema,
	timeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const AgentResultSchema = Schema.Union([
	AgentSucceededSchema,
	AgentFailedSchema,
	AgentCancelledSchema,
	AgentTimedOutSchema,
]);
export type AgentResult = typeof AgentResultSchema.Type;

export const WebSearchRequestSchema = Schema.Struct({
	query: Schema.String,
});
export type WebSearchRequest = typeof WebSearchRequestSchema.Type;

export const WebResultSchema = Schema.Struct({
	text: Schema.String,
	details: Schema.optionalKey(JsonValueSchema),
});
export type WebResult = typeof WebResultSchema.Type;
