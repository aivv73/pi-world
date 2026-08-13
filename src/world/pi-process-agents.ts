import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import {
	type AgentHandleData,
	type AgentResult,
	type AgentSpawnRequest,
	type AgentWaitRequest,
	makeAgentId,
	makeAttemptId,
} from "./domain.js";
import {
	type AgentCancelError,
	type AgentNotFoundError,
	type AgentSpawnError,
	Agents,
	type AgentsService,
	type AgentWaitError,
	type AgentWaitTimeoutError,
} from "./services.js";

const DEFAULT_GRACE_MS = 250;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

export interface PiChildSpawnInput {
	readonly handle: AgentHandleData;
	readonly request: AgentSpawnRequest;
}

export interface PiChildSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PiProcessAgentsOptions {
	readonly cwd: string;
	readonly extensionPath?: string;
	readonly sessionDir?: string;
	readonly defaultModel: string;
	readonly depth: number;
	readonly graceMs?: number;
	readonly maxOutputChars?: number;
	readonly spawnCommand?: (input: PiChildSpawnInput) => PiChildSpec;
}

export type PiProcessAgentEvent =
	| { readonly _tag: "spawned"; readonly agentId: string; readonly pid: number | undefined }
	| { readonly _tag: "term_sent"; readonly agentId: string }
	| { readonly _tag: "kill_sent"; readonly agentId: string }
	| { readonly _tag: "completed"; readonly agentId: string }
	| { readonly _tag: "failed"; readonly agentId: string }
	| { readonly _tag: "cancelled"; readonly agentId: string }
	| { readonly _tag: "timed_out"; readonly agentId: string };

interface AttemptRecord {
	readonly handle: AgentHandleData;
	readonly request: AgentSpawnRequest;
	readonly child: ChildProcess;
	readonly completion: Promise<AgentResult>;
	resolveCompletion: (result: AgentResult) => void;
	status: "running" | "terminal";
	cancelRequested: boolean;
	executionTimedOut: boolean;
	graceTimer: ReturnType<typeof setTimeout> | undefined;
	executionTimer: ReturnType<typeof setTimeout> | undefined;
	stdout: string;
	stderr: string;
}

class WaitTimeout extends Error {
	readonly _tag = "WaitTimeout";
}

const spawnError = (message: string): AgentSpawnError => ({
	_tag: "AgentSpawnError",
	code: "AGENT_SPAWN_FAILED",
	message,
});

const notFound = (agentId: AttemptRecord["handle"]["agentId"]): AgentNotFoundError => ({
	_tag: "AgentNotFoundError",
	code: "AGENT_NOT_FOUND",
	agentId,
	message: `agent ${agentId} was not found`,
});

const waitTimeout = (agentId: AttemptRecord["handle"]["agentId"], timeoutMs: number): AgentWaitTimeoutError => ({
	_tag: "AgentWaitTimeoutError",
	code: "AGENT_WAIT_TIMEOUT",
	agentId,
	timeoutMs,
	message: `waiting for agent ${agentId} exceeded ${timeoutMs}ms`,
});

const waitError = (agentId: AttemptRecord["handle"]["agentId"], message: string): AgentWaitError => ({
	_tag: "AgentWaitError",
	code: "AGENT_WAIT_FAILED",
	agentId,
	message,
});

const cancelError = (agentId: AttemptRecord["handle"]["agentId"], message: string): AgentCancelError => ({
	_tag: "AgentCancelError",
	code: "AGENT_CANCEL_FAILED",
	agentId,
	message,
});

const truncate = (value: string, max: number) => (value.length <= max ? value : `${value.slice(0, max)}…`);

const appendOutput = (record: AttemptRecord, channel: "stdout" | "stderr", chunk: Buffer, max: number) => {
	const current = record[channel];
	record[channel] = truncate(current + chunk.toString(), max);
};

const resultOutput = (record: AttemptRecord) => record.stdout.trim();

const childSpec = (options: PiProcessAgentsOptions, input: PiChildSpawnInput): PiChildSpec => {
	if (options.spawnCommand) return options.spawnCommand(input);
	if (!options.extensionPath) throw new Error("PiProcessAgents requires extensionPath when spawnCommand is omitted");
	const model = input.request.model || options.defaultModel;
	const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : "anthropic";
	const modelId = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
	return {
		command: "pi",
		args: [
			"-p",
			"--no-extensions",
			"-e",
			options.extensionPath,
			"--provider",
			provider,
			"--model",
			modelId,
			...(options.sessionDir ? ["--session-dir", options.sessionDir] : []),
			input.request.task,
		],
	};
};

// Pi can launch grandchildren (the shell is only the immediate parent), so the
// adapter owns a detached process group and signals the group before falling back
// to the direct child. This prevents session shutdown from orphaning descendants.
const killChild = (child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean) => {
	if (child.pid === undefined) return;
	if (processGroup && process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
			return;
		} catch {
			// The process may have exited between the lookup and the group signal.
		}
	}
	child.kill(signal);
};

export interface PiProcessAgents extends AgentsService {
	readonly shutdown: () => Effect.Effect<void>;
	readonly events: readonly PiProcessAgentEvent[];
}

export const makePiProcessAgents = (options: PiProcessAgentsOptions): PiProcessAgents => {
	const records = new Map<AgentRecordId, AttemptRecord>();
	const events: PiProcessAgentEvent[] = [];
	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
	let closed = false;

	const finish = (record: AttemptRecord, result: AgentResult, event: PiProcessAgentEvent) => {
		if (record.status === "terminal") return;
		record.status = "terminal";
		if (record.graceTimer !== undefined) clearTimeout(record.graceTimer);
		if (record.executionTimer !== undefined) clearTimeout(record.executionTimer);
		events.push(event);
		record.resolveCompletion(result);
	};

	const requestTermination = (record: AttemptRecord, timedOut: boolean) => {
		if (record.status === "terminal") return;
		record.cancelRequested = !timedOut;
		record.executionTimedOut = timedOut;
		killChild(record.child, "SIGTERM", true);
		events.push({ _tag: "term_sent", agentId: record.handle.agentId });
		record.graceTimer = setTimeout(() => {
			if (record.status === "terminal") return;
			killChild(record.child, "SIGKILL", true);
			events.push({ _tag: "kill_sent", agentId: record.handle.agentId });
		}, graceMs);
	};

	// A wait timeout only withdraws this observer. The attempt remains in records and
	// its close event still resolves the shared completion promise for a later wait.
	const waitForCompletion = (record: AttemptRecord, timeoutMs: number | undefined, signal: AbortSignal) =>
		new Promise<AgentResult>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timer !== undefined) clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("agent wait interrupted"));
			};
			record.completion.then(
				(result) => {
					cleanup();
					resolve(result);
				},
				(error) => {
					cleanup();
					reject(error);
				},
			);
			if (timeoutMs !== undefined) {
				timer = setTimeout(() => {
					cleanup();
					reject(new WaitTimeout());
				}, timeoutMs);
			}
			signal.addEventListener("abort", onAbort, { once: true });
		});

	const service: AgentsService = {
		spawn: (request) =>
			Effect.suspend(() => {
				if (closed) return Effect.fail(spawnError("agent service is shut down"));
				if (request.task.trim().length === 0) return Effect.fail(spawnError("agent task must not be empty"));
				const handle = {
					agentId: makeAgentId(`agent-${randomUUID()}`),
					attemptId: makeAttemptId(`attempt-${randomUUID()}`),
				};
				let resolveCompletion = (_result: AgentResult) => {};
				const completion = new Promise<AgentResult>((resolve) => {
					resolveCompletion = resolve;
				});
				let child: ChildProcess;
				try {
					const spec = childSpec(options, { handle, request });
					child = spawn(spec.command, [...spec.args], {
						cwd: options.cwd,
						detached: true,
						env: {
							...process.env,
							PI_RLM_DEPTH: String(options.depth + 1),
							PI_RLM_FORCE: "1",
							PI_RLM_CHILD_ID: handle.agentId,
							...spec.env,
						},
						stdio: ["ignore", "pipe", "pipe"],
					});
				} catch (error) {
					return Effect.fail(spawnError(error instanceof Error ? error.message : "child admission failed"));
				}
				const record: AttemptRecord = {
					handle,
					request,
					child,
					completion,
					resolveCompletion,
					status: "running",
					cancelRequested: false,
					executionTimedOut: false,
					graceTimer: undefined,
					executionTimer: undefined,
					stdout: "",
					stderr: "",
				};
				records.set(handle.agentId, record);
				events.push({ _tag: "spawned", agentId: handle.agentId, pid: child.pid });
				child.stdout?.on("data", (chunk: Buffer) => appendOutput(record, "stdout", chunk, maxOutputChars));
				child.stderr?.on("data", (chunk: Buffer) => appendOutput(record, "stderr", chunk, maxOutputChars));
				child.once("error", (error) => {
					finish(
						record,
						{ _tag: "failed", agentId: handle.agentId, attemptId: handle.attemptId, error: error.message },
						{
							_tag: "failed",
							agentId: handle.agentId,
						},
					);
				});
				child.once("close", (code, signal) => {
					if (record.status === "terminal") return;
					if (record.executionTimedOut) {
						finish(
							record,
							{
								_tag: "timed_out",
								agentId: handle.agentId,
								attemptId: handle.attemptId,
								timeoutMs: request.timeoutMs ?? 0,
							},
							{
								_tag: "timed_out",
								agentId: handle.agentId,
							},
						);
					} else if (record.cancelRequested) {
						finish(
							record,
							{
								_tag: "cancelled",
								agentId: handle.agentId,
								attemptId: handle.attemptId,
								reason: "cancelled by caller",
							},
							{
								_tag: "cancelled",
								agentId: handle.agentId,
							},
						);
					} else if (code === 0) {
						finish(
							record,
							{ _tag: "succeeded", agentId: handle.agentId, attemptId: handle.attemptId, output: resultOutput(record) },
							{
								_tag: "completed",
								agentId: handle.agentId,
							},
						);
					} else {
						const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
						finish(
							record,
							{
								_tag: "failed",
								agentId: handle.agentId,
								attemptId: handle.attemptId,
								error: `child exited with ${status}`,
							},
							{
								_tag: "failed",
								agentId: handle.agentId,
							},
						);
					}
				});
				if (request.timeoutMs !== undefined) {
					record.executionTimer = setTimeout(() => requestTermination(record, true), request.timeoutMs);
				}
				return Effect.succeed(handle);
			}),
		wait: (request: AgentWaitRequest) =>
			Effect.suspend<AgentResult, AgentNotFoundError | AgentWaitTimeoutError | AgentWaitError, never>(() => {
				const record = records.get(request.agentId);
				if (!record) return Effect.fail(notFound(request.agentId));
				return Effect.tryPromise({
					try: (signal) => waitForCompletion(record, request.timeoutMs, signal),
					catch: (error) => {
						if (error instanceof WaitTimeout) return waitTimeout(request.agentId, request.timeoutMs ?? 0);
						return waitError(request.agentId, error instanceof Error ? error.message : "agent wait failed");
					},
				});
			}),
		cancel: (agentId) =>
			Effect.suspend<void, AgentNotFoundError | AgentCancelError, never>(() => {
				const record = records.get(agentId);
				if (!record) return Effect.fail(notFound(agentId));
				if (record.status === "terminal") return Effect.succeed(undefined);
				return Effect.tryPromise({
					try: () => {
						requestTermination(record, false);
						return record.completion.then(() => undefined);
					},
					catch: (error) => cancelError(agentId, error instanceof Error ? error.message : "agent cancellation failed"),
				});
			}),
	};

	const shutdown = () =>
		Effect.promise(async () => {
			closed = true;
			await Promise.all(
				[...records.values()].map((record) => {
					if (record.status === "terminal") return Promise.resolve();
					requestTermination(record, false);
					return record.completion.then(() => undefined);
				}),
			);
		});

	return { ...service, shutdown, events };
};

// Layer.effect runs acquisition inside the layer scope; the release callback is
// the session boundary that owns every admitted process, not the execute cell.
export const PiProcessAgentsLive = (options: PiProcessAgentsOptions) =>
	Layer.effect(
		Agents,
		Effect.acquireRelease(
			Effect.sync(() => makePiProcessAgents(options)),
			(agents) => agents.shutdown(),
		),
	);

type AgentRecordId = AgentHandleData["agentId"];
