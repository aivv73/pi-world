import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import {
	makeShellExecutionId,
	type ShellDurationBucket,
	type ShellExecutionHandleData,
	type ShellExecutionId,
	type ShellOutput,
	type ShellStatus,
	type ShellTerminalResult,
	type ShellWaitRequest,
	type VirtualShellExecRequest,
	type WorldSubject,
} from "./domain.js";
import { Shell, type ShellExecutionNotFound, type ShellService, type ShellWaitTimeoutError } from "./services.js";

export type DeterministicShellEvent =
	| { readonly _tag: "admitted"; readonly executionId: ShellExecutionId }
	| { readonly _tag: "settled"; readonly executionId: ShellExecutionId; readonly branch: ShellStatus["_tag"] }
	| { readonly _tag: "waited"; readonly executionId: ShellExecutionId; readonly timeoutMs?: number }
	| { readonly _tag: "cancelled"; readonly executionId: ShellExecutionId }
	| { readonly _tag: "attached"; readonly executionId: ShellExecutionId };

/** Host-owned, deterministic terminal branch for one admission. */
export type ShellOutcomeDeclaration =
	| { readonly _tag: "exited"; readonly exitCode: number; readonly stdoutBytes?: number; readonly stderrBytes?: number }
	| {
			readonly _tag: "budget_exhausted";
			readonly limit: "time" | "output" | "memory";
			readonly stdoutBytes?: number;
			readonly stderrBytes?: number;
	  }
	| { readonly _tag: "failed"; readonly code: string; readonly stdoutBytes?: number; readonly stderrBytes?: number };

export interface DeterministicShellOptions {
	/** Simulated queue time before an execution starts. Default 0. */
	readonly queueMs?: number;
	/** Simulated execution time to the terminal branch. Default 0. */
	readonly executionMs?: number;
	/** Execution timeout budget; when the simulated execution exceeds it, the branch is timed_out. */
	readonly executionTimeoutMs?: number;
	/** Deterministic per-admission branch; the default is exited with code 0. */
	readonly outcome?: (admission: {
		readonly sequence: number;
		readonly script: string;
	}) => ShellOutcomeDeclaration | undefined;
	/** Retention: at most this many records are kept for the session. Default 1000. */
	readonly recordsCap?: number;
	/** Retention: a record expires this long after admission. Default one hour. */
	readonly expireAfterMs?: number;
	/** Retention: combined stored base64 characters across retained outputs. Default 4 MiB. */
	readonly outputCharsCap?: number;
	/** Per-stream capture cap in bytes; a policy profile may bound this further. Default 64 KiB. */
	readonly captureBytesCap?: number;
	/** Host-side observer fired exactly once when an execution reaches a terminal branch. */
	readonly onTerminal?: (event: {
		readonly executionId: ShellExecutionId;
		readonly branch: ShellStatus["_tag"];
	}) => void;
	/** Host-side observer fired when retention removes a record entirely. */
	readonly onDropped?: (executionId: ShellExecutionId) => void;
}

// The event log is a host-side diagnostic seam, not a record store: it is
// capped and carries no script content, so a session-long adapter cannot
// accumulate model-authored scripts.
const EVENT_BUFFER_CAP = 500;
const DEFAULT_RECORDS_CAP = 1_000;
const DEFAULT_EXPIRE_AFTER_MS = 60 * 60 * 1000;
const DEFAULT_OUTPUT_CHARS_CAP = 4 * 1024 * 1024;

interface ShellRecord {
	readonly executionId: ShellExecutionId;
	readonly sessionId: string;
	readonly admittedAt: number;
	readonly queueMs: number;
	readonly settleDelay: number;
	readonly status: ShellStatus;
	readonly stdoutBytes: number;
	readonly stderrBytes: number;
	terminal: ShellTerminalResult | undefined;
	readonly pending: Promise<ShellTerminalResult>;
	readonly resolve: (value: ShellTerminalResult) => void;
	payloadChars: number;
	settleTimer?: ReturnType<typeof setTimeout>;
}

/** Default per-stream capture cap; a governing policy profile may bound it further. */
export const DEFAULT_OUTPUT_CAPTURE_BYTES = 64 * 1024;

const bucketOf = (ms: number): ShellDurationBucket =>
	ms < 10
		? "lt_10ms"
		: ms < 100
			? "lt_100ms"
			: ms < 1000
				? "lt_1s"
				: ms < 10_000
					? "lt_10s"
					: ms < 60_000
						? "lt_1m"
						: "ge_1m";

// A deterministic byte pattern so a re-run of the same admission produces the
// same capture, while the capture stays a bounded prefix of the declared run.
const makeBuildOutput =
	(captureCap: number) =>
	(totalBytes: number): ShellOutput => {
		const capturedBytes = Math.min(totalBytes, captureCap);
		const raw = new Uint8Array(capturedBytes);
		for (let i = 0; i < capturedBytes; i += 1) raw[i] = (i * 31 + 7) % 256;
		return Object.freeze({
			encoding: "base64" as const,
			data: Buffer.from(raw).toString("base64"),
			capturedBytes,
			totalBytes,
			truncated: totalBytes > capturedBytes,
		});
	};

// Erased output keeps the record shape with nothing captured: callers see a
// bounded capture that was cut, never why retention removed it.
const blankedOutput = (original: ShellOutput): ShellOutput =>
	Object.freeze({
		encoding: "base64" as const,
		data: "",
		capturedBytes: 0,
		totalBytes: original.totalBytes,
		truncated: original.totalBytes > 0,
	});

const notFound = (operation: "shell.wait" | "shell.cancel" | "shell.attach"): ShellExecutionNotFound => ({
	_tag: "ShellExecutionNotFound",
	code: "SHELL_EXECUTION_NOT_FOUND",
	operation,
	// One message for unknown, foreign, unauthorized, and expired IDs:
	// distinguishing them would turn errors into an execution enumerator.
	message: "shell execution was not found",
});

const waitTimeoutError = (request: ShellWaitRequest): ShellWaitTimeoutError => ({
	_tag: "ShellWaitTimeoutError",
	code: "SHELL_WAIT_TIMEOUT",
	operation: "shell.wait",
	executionId: request.executionId,
	timeoutMs: request.timeoutMs ?? 0,
	message: `waiting for a shell execution exceeded ${request.timeoutMs ?? 0}ms`,
});

/**
 * Contract tracer for the World Shell execution boundary.
 *
 * It deliberately executes nothing: the simulated queue, execution, timeout,
 * and branch are declared host-side under the virtual-tracer-v1 profile, so
 * every admitted execution walks the real admission, wait, cancel, attach,
 * and retention path and reaches exactly one closed v1 terminal branch. The
 * real ambient-free Virtual Environment replaces this adapter.
 */
export const makeDeterministicShell = (options: DeterministicShellOptions = {}) => {
	const queueMs = options.queueMs ?? 0;
	const executionMs = options.executionMs ?? 0;
	const executionTimeoutMs = options.executionTimeoutMs;
	const recordsCap = options.recordsCap ?? DEFAULT_RECORDS_CAP;
	const expireAfterMs = options.expireAfterMs ?? DEFAULT_EXPIRE_AFTER_MS;
	const outputCharsCap = options.outputCharsCap ?? DEFAULT_OUTPUT_CHARS_CAP;
	const buildOutput = makeBuildOutput(options.captureBytesCap ?? DEFAULT_OUTPUT_CAPTURE_BYTES);

	const records = new Map<ShellExecutionId, ShellRecord>();
	const events: DeterministicShellEvent[] = [];
	const onTerminal = options.onTerminal ?? (() => {});
	const onDropped = options.onDropped ?? (() => {});
	let sequence = 0;

	const pushEvent = (event: DeterministicShellEvent) => {
		events.push(event);
		if (events.length > EVENT_BUFFER_CAP) events.splice(0, events.length - EVENT_BUFFER_CAP);
	};

	const buildTerminal = (
		record: ShellRecord,
		kind: "settled" | "cancelled" | "shutdown",
		now = Date.now(),
	): ShellTerminalResult => {
		const elapsed = kind === "settled" ? record.settleDelay : now - record.admittedAt;
		const queued = Math.min(record.queueMs, elapsed);
		// An execution with an empty queue starts at admission, so equality
		// counts as started; a cancel strictly inside the queue window does not.
		const started = elapsed >= record.queueMs;
		const runtime = started ? elapsed - record.queueMs : 0;
		// A cancelled simulation produced nothing: declared output only lands
		// when the execution reaches its declared branch.
		const output = (declaredBytes: number): ShellOutput =>
			kind === "settled" ? buildOutput(declaredBytes) : buildOutput(0);
		const status: ShellStatus =
			kind === "settled"
				? record.status
				: Object.freeze({ _tag: "cancelled", reason: kind === "shutdown" ? "shutdown" : "caller" });
		return Object.freeze({
			schemaVersion: 1,
			executionId: record.executionId,
			mode: "virtual",
			profileId: "virtual-tracer-v1",
			started,
			queueDurationBucket: bucketOf(queued),
			runtimeDurationBucket: bucketOf(runtime),
			stdout: output(record.stdoutBytes),
			stderr: output(record.stderrBytes),
			sensitivity: "untrusted_output",
			sideEffectsMayHaveOccurred: false,
			cleanup: "not_needed",
			virtualState: Object.freeze({ disposition: "unchanged" }),
			status: Object.freeze(status),
		});
	};

	const reachTerminal = (record: ShellRecord, kind: "settled" | "cancelled" | "shutdown") => {
		const terminal = buildTerminal(record, kind);
		record.terminal = terminal;
		if (kind === "settled") record.payloadChars = terminal.stdout.data.length + terminal.stderr.data.length;
		if (record.settleTimer !== undefined) clearTimeout(record.settleTimer);
		record.resolve(record.terminal);
		pushEvent({
			_tag: kind === "settled" ? "settled" : "cancelled",
			executionId: record.executionId,
			...(kind === "settled" ? { branch: record.status._tag } : {}),
		} as DeterministicShellEvent);
		onTerminal({ executionId: record.executionId, branch: record.terminal.status._tag });
		enforceRetention(Date.now());
	};

	const settle = (record: ShellRecord) => {
		if (record.terminal !== undefined) return;
		reachTerminal(record, "settled");
	};

	const dropRecord = (executionId: ShellExecutionId) => {
		const record = records.get(executionId);
		if (record === undefined) return;
		if (record.settleTimer !== undefined) clearTimeout(record.settleTimer);
		// Every admitted execution still reaches one closed branch: a pending
		// record is terminated as a shutdown cancellation before eviction, so
		// the taxonomy holds even when retention removes the record.
		if (record.terminal === undefined) {
			record.terminal = buildTerminal(record, "shutdown");
			onTerminal({ executionId: record.executionId, branch: record.terminal.status._tag });
		}
		record.resolve(record.terminal);
		records.delete(executionId);
		onDropped(executionId);
	};

	const blankOutput = (record: ShellRecord) => {
		const terminal = record.terminal;
		if (terminal === undefined) return;
		record.terminal = Object.freeze({
			...terminal,
			stdout: blankedOutput(terminal.stdout),
			stderr: blankedOutput(terminal.stderr),
		});
		record.payloadChars = 0;
	};

	// Retention order matters: payload pressure erases output while the
	// metadata stays; only session and time caps evict the whole record.
	const enforceRetention = (now: number) => {
		for (const [executionId, record] of records) {
			if (now - record.admittedAt > expireAfterMs) dropRecord(executionId);
		}
		while (records.size > recordsCap) {
			const oldest = records.entries().next().value?.[0];
			if (oldest === undefined) break;
			dropRecord(oldest);
		}
		let payload = 0;
		for (const record of records.values()) payload += record.payloadChars;
		while (payload > outputCharsCap) {
			const victim = records.values().find((record) => record.terminal !== undefined && record.payloadChars > 0);
			if (victim === undefined) break;
			blankOutput(victim);
			payload = 0;
			for (const record of records.values()) payload += record.payloadChars;
		}
	};

	// A foreign-session subject is refused exactly like an unknown ID.
	const lookupAuthorized = (executionId: ShellExecutionId, subject: WorldSubject): ShellRecord | undefined => {
		const record = records.get(executionId);
		return record !== undefined && record.sessionId === subject.sessionId ? record : undefined;
	};

	const service: ShellService = {
		virtualExec: (request: VirtualShellExecRequest, owner: WorldSubject) =>
			Effect.suspend(() => {
				enforceRetention(Date.now());
				sequence += 1;
				const executionId = makeShellExecutionId(randomUUID());
				const declaration = options.outcome?.({ sequence, script: request.script });
				const total = queueMs + executionMs;
				const timedOut = executionTimeoutMs !== undefined && executionTimeoutMs < total;
				// The terminal branch is a closed record: declared output sizes
				// stay on the admission, never on the status.
				const status: ShellStatus = timedOut
					? { _tag: "timed_out", timeoutMs: executionTimeoutMs }
					: declaration === undefined
						? { _tag: "exited", exitCode: 0 }
						: declaration._tag === "exited"
							? { _tag: "exited", exitCode: declaration.exitCode }
							: declaration._tag === "budget_exhausted"
								? { _tag: "budget_exhausted", limit: declaration.limit }
								: { _tag: "failed", code: declaration.code };
				let resolve: (value: ShellTerminalResult) => void = () => {};
				const pending = new Promise<ShellTerminalResult>((done) => {
					resolve = done;
				});
				const record: ShellRecord = {
					executionId,
					sessionId: owner.sessionId,
					admittedAt: Date.now(),
					queueMs,
					settleDelay: timedOut ? (executionTimeoutMs as number) : total,
					status: Object.freeze(status),
					stdoutBytes: (declaration?.stdoutBytes ?? 0) | 0,
					stderrBytes: (declaration?.stderrBytes ?? 0) | 0,
					terminal: undefined,
					pending,
					resolve,
					payloadChars: 0,
				};
				records.set(executionId, record);
				pushEvent({ _tag: "admitted", executionId });
				if (record.settleDelay <= 0) settle(record);
				else {
					const timer = setTimeout(() => settle(record), record.settleDelay);
					(timer as { unref?: () => void }).unref?.();
					record.settleTimer = timer;
				}
				return Effect.succeed({ executionId } satisfies ShellExecutionHandleData);
			}),
		wait: (request: ShellWaitRequest, subject: WorldSubject) =>
			Effect.suspend<ShellTerminalResult, ShellExecutionNotFound | ShellWaitTimeoutError, never>(() => {
				enforceRetention(Date.now());
				const record = lookupAuthorized(request.executionId, subject);
				if (record === undefined) return Effect.fail(notFound("shell.wait"));
				pushEvent({ _tag: "waited", executionId: request.executionId, timeoutMs: request.timeoutMs });
				if (record.terminal !== undefined) return Effect.succeed(record.terminal);
				const settled = Effect.callback<ShellTerminalResult>((resume) => {
					// The pending promise always resolves with a terminal record:
					// settlement, cancellation, or shutdown on retention eviction.
					record.pending.then((terminal) => resume(Effect.succeed(terminal)));
				});
				if (request.timeoutMs === undefined) return settled;
				// A timed-out wait withdraws the observation only: the race
				// interrupts this waiter, and the admission keeps running.
				return Effect.raceAllFirst([
					settled,
					Effect.fail(waitTimeoutError(request)).pipe(Effect.delay(request.timeoutMs)),
				]);
			}),
		cancel: (request, subject) =>
			Effect.suspend<void, ShellExecutionNotFound, never>(() => {
				enforceRetention(Date.now());
				const record = lookupAuthorized(request.executionId, subject);
				if (record === undefined) return Effect.fail(notFound("shell.cancel"));
				if (record.terminal !== undefined) return Effect.succeed(undefined);
				reachTerminal(record, "cancelled");
				return Effect.succeed(undefined);
			}),
		attach: (request, subject) =>
			Effect.suspend<ShellExecutionHandleData, ShellExecutionNotFound, never>(() => {
				enforceRetention(Date.now());
				const record = lookupAuthorized(request.executionId, subject);
				if (record === undefined) return Effect.fail(notFound("shell.attach"));
				pushEvent({ _tag: "attached", executionId: record.executionId });
				return Effect.succeed({ executionId: record.executionId });
			}),
	};

	return {
		service,
		events,
		pendingCount: () => [...records.values()].filter((record) => record.terminal === undefined).length,
		recordCount: () => records.size,
	};
};

export const DeterministicShellLive = () => Layer.succeed(Shell)(makeDeterministicShell().service);
