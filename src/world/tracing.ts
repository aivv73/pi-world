import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { type Context, Effect, Exit, Option, Tracer } from "effect";

export const WORLD_SPANS = {
	coordinator: "world.execute",
	webSearch: "world.web.search",
	agentSpawn: "world.agents.spawn",
	agentAttempt: "world.agent.attempt",
	piProcess: "world.pi.process",
	agentWait: "world.agents.wait",
	agentCancel: "world.agents.cancel",
	shellVirtualExec: "world.shell.virtual.exec",
	shellWait: "world.shell.wait",
} as const;

export const WORLD_TRACE_ATTRIBUTE_KEYS = [
	"world.operation",
	"world.depth",
	"world.adapter",
	"world.outcome",
	"world.error_code",
	"world.timeout_ms",
	"world.cancel_reason",
	"agent.id",
	"attempt.id",
	"shell.execution_id",
	"process.pid",
] as const;

const operations = new Set([
	"agents.spawn",
	"agents.wait",
	"agents.cancel",
	"web.search",
	"shell.virtual.exec",
	"shell.wait",
]);
const adapters = new Set(["pi-process", "codex-conversion", "deterministic-shell"]);
const outcomes = new Set([
	"succeeded",
	"failed",
	"cancelled",
	"timed_out",
	"denied",
	"invalid",
	"interrupted",
	"shutdown",
]);
const errorCodes = new Set([
	"WORLD_INVALID_REQUEST",
	"WORLD_INTERNAL_ERROR",
	"WORLD_ACCESS_DENIED",
	"AGENT_SPAWN_FAILED",
	"AGENT_NOT_FOUND",
	"AGENT_WAIT_TIMEOUT",
	"AGENT_WAIT_FAILED",
	"AGENT_CANCEL_FAILED",
	"WEB_SEARCH_FAILED",
	"SHELL_INVALID_REQUEST",
	"SHELL_AUTHORITY_DENIED",
	"SHELL_EXECUTION_NOT_FOUND",
]);
const cancelReasons = new Set(["caller", "execution_timeout", "shutdown"]);
const opaqueId = /^[a-f0-9]{16}$/;
const boundedInteger = (value: unknown, max: number) =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

const traceIdKey = randomBytes(32);
export const opaqueTraceId = (value: string) =>
	createHmac("sha256", traceIdKey).update(value).digest("hex").slice(0, 16);

const safeAttribute = (key: string, value: unknown) => {
	switch (key) {
		case "world.operation":
			return operations.has(String(value));
		case "world.adapter":
			return adapters.has(String(value));
		case "world.outcome":
			return outcomes.has(String(value));
		case "world.error_code":
			return errorCodes.has(String(value));
		case "world.cancel_reason":
			return cancelReasons.has(String(value));
		case "agent.id":
		case "attempt.id":
		case "shell.execution_id":
			return typeof value === "string" && opaqueId.test(value);
		case "world.depth":
			return boundedInteger(value, 32);
		case "world.timeout_ms":
			return boundedInteger(value, 2_147_483_647);
		case "process.pid":
			return boundedInteger(value, Number.MAX_SAFE_INTEGER);
		default:
			return false;
	}
};

/**
 * A tracer sees only a successful void Exit. The real typed Exit is restored
 * after the span ends, outside the tracer boundary.
 */
export const withPrivacySafeSpan = <A, E, R>(
	name: string,
	effect: Effect.Effect<A, E, R>,
	attributes: Record<string, unknown>,
) => {
	let captured: Exit.Exit<A, E> | undefined;
	return effect.pipe(
		Effect.exit,
		Effect.tap((exit) =>
			Effect.sync(() => {
				captured = exit;
			}),
		),
		Effect.asVoid,
		Effect.withSpan(name, { attributes }, { captureStackTrace: false }),
		Effect.andThen(
			Effect.suspend(() =>
				captured
					? Exit.match(captured, {
							onSuccess: (value) => Effect.succeed(value),
							onFailure: (cause) => Effect.failCause(cause),
						})
					: Effect.die("traced operation ended without an Exit"),
			),
		),
	);
};

export interface RecordedWorldSpan {
	readonly name: string;
	readonly spanId: string;
	readonly parentSpanId: string | undefined;
	readonly attributes: Readonly<Record<string, unknown>>;
	readonly status: "started" | "succeeded" | "failed";
}

export interface InMemoryWorldTracer {
	readonly tracer: Tracer.Tracer;
	readonly spans: () => readonly RecordedWorldSpan[];
}

class PrivacySafeSpan implements Tracer.Span {
	readonly _tag = "Span";
	readonly spanId = randomUUID();
	readonly traceId: string;
	readonly attributes = new Map<string, unknown>();
	readonly links: Tracer.SpanLink[] = [];
	status: Tracer.SpanStatus;

	constructor(
		readonly name: string,
		readonly parent: Option.Option<Tracer.AnySpan>,
		readonly annotations: Context.Context<never>,
		readonly sampled: boolean,
		readonly kind: Tracer.SpanKind,
		startTime: bigint,
	) {
		this.traceId = Option.getOrUndefined(parent)?.traceId ?? randomUUID();
		this.status = { _tag: "Started", startTime };
	}

	end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
		const startTime = this.status.startTime;
		// Never retain the original failure Cause: it can contain provider text,
		// child output, credentials, or a model-authored prompt.
		this.status = {
			_tag: "Ended",
			startTime,
			endTime,
			exit: Exit.isSuccess(exit) ? Exit.succeed(undefined) : Exit.fail("failed"),
		};
	}

	attribute(key: string, value: unknown) {
		if (safeAttribute(key, value)) this.attributes.set(key, value);
	}

	event(_name: string, _startTime: bigint, _attributes?: Record<string, unknown>) {}

	addLinks(_links: ReadonlyArray<Tracer.SpanLink>) {}
}

/** Test tracer that exports only allowlisted scalar fields and coarse status. */
export const makeInMemoryWorldTracer = (): InMemoryWorldTracer => {
	const spans: PrivacySafeSpan[] = [];
	const tracer = Tracer.make({
		span(options) {
			const span = new PrivacySafeSpan(
				options.name,
				options.parent,
				options.annotations,
				options.sampled,
				options.kind,
				options.startTime,
			);
			spans.push(span);
			return span;
		},
	});
	return {
		tracer,
		spans: () =>
			spans.map((span) => ({
				name: span.name,
				spanId: span.spanId,
				parentSpanId: Option.getOrUndefined(span.parent)?.spanId,
				attributes: Object.fromEntries(span.attributes),
				status:
					span.status._tag === "Started" ? "started" : span.status.exit._tag === "Success" ? "succeeded" : "failed",
			})),
	};
};
