/**
 * EngineManager — the host half of the evaluator.
 *
 * Owns one persistent Bun guest process, speaks the line-JSON protocol over a
 * private pipe, and exposes the execute / snapshot / restore API the `execute`
 * tool is built on.
 *
 * The guarantees it is responsible for:
 *   - one cell runs at a time, in submission order;
 *   - output is attributed to the cell that produced it, and stops the moment
 *     that cell is cancelled;
 *   - the namespace outlives errors, cancellation, and session resume.
 *
 * ARCHITECTURE.md explains how these are achieved and why they matter.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	decodeMessage,
	encodeMessage,
	type GuestToHostMessage,
	type HostToGuestMessage,
	NONCE_ENV,
	PROTOCOL_FD,
} from "./protocol.js";

const GUEST_PATH = fileURLToPath(new URL("./guest.ts", import.meta.url));
const DEFAULT_MAX_OUTPUT_CHARS = 65536;
const READY_TIMEOUT_MS = 10_000;
const ABORT_GRACE_MS = 500;
const PING_TIMEOUT_MS = 5_000;
const DEFAULT_SNAPSHOT_DEBOUNCE_MS = 1500;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 30_000;

export interface EngineExecuteError {
	/** Error class name, e.g. "TypeError". */
	name: string;
	message: string;
	/** Stack trace, split into lines. */
	stack: string[];
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	/** Rendered value of the cell's final expression, when it has one. */
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: EngineExecuteError;
	durationMs: number;
}

export interface ExecuteOptions {
	/** Aborting cancels the cell cooperatively; namespace is preserved. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	/** Cap stdout / stderr / result at this many characters. Default 65536. */
	maxOutputChars?: number;
}

/** Handles one typed request from guest code. Reply is sent back verbatim. */
export type HostRequestHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
export type HostRequestHandlers = Record<string, HostRequestHandler>;

export interface SnapshotResult {
	path: string;
	/** Top-level names successfully serialized. */
	saved: string[];
	/** Names that could not be serialized, with reasons. */
	failed: { name: string; reason: string }[];
}

export interface RestoreResult {
	path: string;
	restored: string[];
	failed: { name: string; reason: string }[];
}

export interface EngineOptions {
	cwd?: string;
	env?: Record<string, string>;
	hostHandlers?: HostRequestHandlers;
	/** Persist/revive the namespace across engine restarts. */
	snapshot?: {
		path: string;
		/** Debounce for the auto-snapshot after each ok cell. Default 1500 ms. */
		debounceMs?: number;
	};
}

/**
 * Thrown by execute() when a cancelled cell is still occupying the evaluator.
 *
 * Cancellation is cooperative, so a cell spinning in synchronous code never
 * yields and no later cell can run. The engine cannot resolve this on its own;
 * the caller recovers by killing the engine and starting a fresh one, whose
 * restoreState() brings the last snapshotted namespace back.
 */
export class EngineBusyError extends Error {
	constructor() {
		super("Engine is still running the previously interrupted cell. Kill the engine to start fresh.");
		this.name = "EngineBusyError";
	}
}

interface ActiveExecution {
	cellId: string;
	code: string;
	started: number;
	maxChars: number;
	opts: ExecuteOptions;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	result?: string;
	error?: EngineExecuteError;
	status: ExecuteResult["status"];
	settled: boolean;
	/** Set on cancellation: a cancelled cell must stop contributing output at once. */
	abortRequested: boolean;
	resolve(result: ExecuteResult): void;
	reject(error: Error): void;
}

// ── process-wide cleanup ─────────────────────────────────────────────────────
// Guests are killed when the host exits normally. As a backstop the guest also
// self-exits when its stdin reaches EOF, which covers a host death abrupt
// enough that no handler runs.

const liveEngines = new Set<EngineManager>();
let cleanupHandlersInstalled = false;

function installProcessCleanupOnce(): void {
	if (cleanupHandlersInstalled) return;
	cleanupHandlersInstalled = true;
	process.on("exit", () => {
		for (const engine of liveEngines) engine.killSync();
	});
}

interface PendingRequest {
	resolve(message: GuestToHostMessage): void;
	reject(error: Error): void;
	timer?: ReturnType<typeof setTimeout>;
}

function truncateWithMarker(text: string, maxChars: number, wasTruncated: boolean): string {
	if (!wasTruncated && text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[... output truncated at ${maxChars} chars ...]`;
}

export class EngineManager {
	private readonly options: EngineOptions;
	private child?: ChildProcess;
	private state: "idle" | "starting" | "running" | "shutdown" = "idle";
	private startPromise?: Promise<void>;
	private executionQueue: Promise<unknown> = Promise.resolve();
	private activeExecution?: ActiveExecution;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	/** Per-process protocol nonce; also names the guest's internal bindings. */
	private readonly nonce = randomUUID().replaceAll("-", "");
	/** Tail of the guest's own stderr, surfaced when it dies unexpectedly. */
	private guestStderr = "";
	/** Held so the protocol reader is not garbage-collected mid-session, which
	 * would close the guest's write end and kill it with EPIPE. */
	private protocolReader?: ReturnType<typeof createInterface>;
	private lastCellCode?: string;
	/** Set when an aborted cell may still be wedging the guest's event loop. */
	private maybeWedged = false;
	private snapshotTimer?: ReturnType<typeof setTimeout>;

	constructor(options: EngineOptions = {}) {
		this.options = options;
	}

	get isRunning(): boolean {
		return this.state === "running";
	}

	// ── lifecycle ──────────────────────────────────────────────────────────────

	async start(): Promise<void> {
		if (this.state === "shutdown") throw new Error("Engine has been shut down");
		if (!this.startPromise) {
			const startup = this.doStart().catch((error) => {
				this.startPromise = undefined;
				throw error;
			});
			// Callers await the rejection; this guard keeps a startup failure that
			// nobody is waiting on from surfacing as an unhandled rejection.
			startup.catch(() => {});
			this.startPromise = startup;
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		this.state = "starting";
		installProcessCleanupOnce();
		liveEngines.add(this);
		const child = spawn("bun", ["run", GUEST_PATH], {
			cwd: this.options.cwd,
			env: {
				...process.env,
				...(this.options.env ?? {}),
				[NONCE_ENV]: this.nonce,
			},
			// fd 3 carries protocol traffic so stdout/stderr stay pure user output.
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		this.child = child;

		const ready = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Engine guest did not become ready in time")), READY_TIMEOUT_MS);
			timer.unref?.();
			this.pendingRequests.set("__ready__", {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});

		const protocolStream = child.stdio[PROTOCOL_FD] as NodeJS.ReadableStream | null;
		if (!protocolStream) {
			throw new Error("Engine guest was spawned without a protocol pipe on fd 3");
		}
		this.protocolReader = createInterface({ input: protocolStream });
		this.protocolReader.on("line", (line) => this.handleGuestLine(line));
		// Anything the guest writes to the real stdout/stderr fds is subprocess
		// output (Bun.$ without .quiet()); attribute it to the running cell.
		child.stdout!.on("data", (buffer: Buffer) => this.appendActiveOutput("stdout", buffer.toString()));
		child.stderr!.on("data", (buffer: Buffer) => {
			const text = buffer.toString();
			this.guestStderr = (this.guestStderr + text).slice(-4000);
			this.appendActiveOutput("stderr", text);
		});

		child.on("error", (error) => {
			this.failAllPending(new Error(`Engine process failed: ${error.message}`));
			this.transitionToShutdown(`Engine process failed: ${error.message}`);
		});
		child.on("exit", (code, signal) => {
			if (this.state !== "shutdown") {
				const tail = this.guestStderr.trim();
				const reason =
					`Engine process exited unexpectedly (code=${code} signal=${signal})` +
					(tail ? `\nguest stderr:\n${tail.slice(-1500)}` : "");
				this.failAllPending(new Error(reason));
				this.transitionToShutdown(reason);
			}
		});

		await ready;
		this.state = "running";
	}

	private transitionToShutdown(reason: string): void {
		this.state = "shutdown";
		this.clearSnapshotTimer();
		const active = this.activeExecution;
		if (active && !active.settled) {
			this.activeExecution = undefined;
			active.settled = true;
			active.reject(new Error(reason));
		}
	}

	private failAllPending(error: Error): void {
		for (const [, pending] of this.pendingRequests) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	async kill(): Promise<void> {
		this.killSync();
	}

	/** Synchronous teardown, safe from process.on("exit"). */
	killSync(): void {
		this.clearSnapshotTimer();
		const active = this.activeExecution;
		if (active && !active.settled) {
			active.status = "aborted";
			this.settleActiveExecution(active);
		}
		this.state = "shutdown";
		liveEngines.delete(this);
		this.failAllPending(new Error("Engine has been shut down"));
		this.child?.kill("SIGKILL");
		this.child = undefined;
		this.protocolReader?.close();
		this.protocolReader = undefined;
	}

	/** Graceful cleanup: flush a final snapshot, then terminate the guest. */
	async dispose(): Promise<void> {
		if (this.state === "running") {
			await this.snapshotState().catch(() => null);
		}
		await this.kill();
	}

	// ── guest messaging ────────────────────────────────────────────────────────

	private sendToGuest(message: HostToGuestMessage): void {
		this.child?.stdin?.write(encodeMessage(message, this.nonce));
	}

	private request(message: HostToGuestMessage & { id: string }, timeoutMs: number): Promise<GuestToHostMessage> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(message.id);
				reject(new Error(`Engine request ${message.type} timed out`));
			}, timeoutMs);
			timer.unref?.();
			this.pendingRequests.set(message.id, { resolve, reject, timer });
			this.sendToGuest(message);
		});
	}

	private handleGuestLine(line: string): void {
		// fd 3 carries only protocol traffic; a line that fails to decode (wrong
		// nonce, malformed) is discarded rather than shown as output.
		const message = decodeMessage<GuestToHostMessage>(line, this.nonce);
		if (!message) return;
		switch (message.type) {
			case "ready": {
				const pending = this.pendingRequests.get("__ready__");
				if (pending) {
					this.pendingRequests.delete("__ready__");
					pending.resolve(message);
				}
				break;
			}
			case "stream": {
				const active = this.activeExecution;
				// Untagged output belongs to no cell; attributing it to whichever cell
				// is active is the same class of bug as the orphan leak.
				if (!active || active.settled || message.cellId !== active.cellId) return;
				this.appendOutput(active, message.name, message.chunk);
				break;
			}
			case "done": {
				const active = this.activeExecution;
				if (!active || active.settled || active.cellId !== message.cellId) return;
				if (message.status === "error") {
					active.status = "error";
					active.error = message.error;
				} else if (message.status === "aborted") {
					active.status = "aborted";
				} else {
					active.result = message.result;
				}
				this.settleActiveExecution(active);
				break;
			}
			case "pong": {
				this.resolveRequest(message.id, message);
				break;
			}
			case "snapshot_result":
			case "restore_result":
			case "names_result": {
				this.resolveRequest(message.id, message);
				break;
			}
			case "host_request": {
				void this.dispatchHostRequest(message.id, message.requestType, message.payload);
				break;
			}
		}
	}

	private resolveRequest(id: string, message: GuestToHostMessage): void {
		const pending = this.pendingRequests.get(id);
		if (!pending) return;
		this.pendingRequests.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(message);
	}

	private async dispatchHostRequest(id: string, requestType: string, payload: Record<string, unknown>): Promise<void> {
		try {
			const handler = this.options.hostHandlers?.[requestType];
			if (!handler) {
				throw new Error(`host request type "${requestType}" is not available in this session`);
			}
			// Attribute the request to the cell that (transitively) issued it.
			const cellSourceCode = this.activeExecution?.code ?? this.lastCellCode;
			const reply = await handler({ ...payload, cellSourceCode });
			this.sendToGuest({ type: "host_reply", id, status: "ok", payload: reply });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sendToGuest({ type: "host_reply", id, status: "error", error: message });
		}
	}

	// ── output accumulation ────────────────────────────────────────────────────

	private appendActiveOutput(name: "stdout" | "stderr", text: string): void {
		const active = this.activeExecution;
		if (!active || active.settled) return;
		this.appendOutput(active, name, text);
	}

	private appendOutput(active: ActiveExecution, name: "stdout" | "stderr", text: string): void {
		if (active.abortRequested) return;
		const key = name === "stdout" ? "stdout" : "stderr";
		const truncatedKey = name === "stdout" ? "stdoutTruncated" : "stderrTruncated";
		if (active[key].length < active.maxChars) {
			active[key] += text;
			if (active[key].length > active.maxChars) {
				active[key] = active[key].slice(0, active.maxChars);
				active[truncatedKey] = true;
			}
		} else {
			active[truncatedKey] = true;
		}
		active.opts.onStream?.(text, name);
	}

	// ── execute ────────────────────────────────────────────────────────────────

	async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		// Claim the queue slot synchronously, before the first await, so that
		// submission order is execution order for concurrent callers.
		const previous = this.executionQueue;
		let release: () => void = () => {};
		this.executionQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;

		try {
			if (opts.signal?.aborted) {
				return { stdout: "", stderr: "", status: "aborted", durationMs: 0 };
			}
			if (this.state === "shutdown") {
				throw new Error("Engine has been shut down");
			}
			await this.start();
			if ((this.state as string) === "shutdown") {
				throw new Error("Engine has been shut down");
			}
			if (this.maybeWedged) {
				await this.assertGuestResponsive();
			}
			const result = await this.executeInner(code, opts);
			if (result.status === "ok") this.scheduleSnapshot();
			return result;
		} finally {
			release();
		}
	}

	private async assertGuestResponsive(): Promise<void> {
		try {
			await this.request({ type: "ping", id: randomUUID() }, PING_TIMEOUT_MS);
			this.maybeWedged = false;
		} catch (error) {
			if (this.state === "shutdown" || !this.child) {
				throw new Error("Engine has been shut down");
			}
			void error;
			throw new EngineBusyError();
		}
	}

	private executeInner(code: string, opts: ExecuteOptions): Promise<ExecuteResult> {
		const cellId = randomUUID();
		const started = Date.now();
		this.lastCellCode = code;

		return new Promise<ExecuteResult>((resolve, reject) => {
			const active: ActiveExecution = {
				cellId,
				code,
				started,
				maxChars: opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
				opts,
				stdout: "",
				stderr: "",
				stdoutTruncated: false,
				stderrTruncated: false,
				status: "ok",
				settled: false,
				abortRequested: false,
				resolve,
				reject,
			};
			this.activeExecution = active;

			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				active.abortRequested = true;
				this.sendToGuest({ type: "abort", cellId });
				this.maybeWedged = true;
				graceTimer = setTimeout(() => {
					if (this.activeExecution === active && !active.settled) {
						active.status = "aborted";
						this.settleActiveExecution(active);
					}
				}, ABORT_GRACE_MS);
				graceTimer.unref?.();
			};
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			const originalResolve = active.resolve;
			active.resolve = (result) => {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
				originalResolve(result);
			};
			const originalReject = active.reject;
			active.reject = (error) => {
				opts.signal?.removeEventListener("abort", onAbort);
				if (graceTimer) clearTimeout(graceTimer);
				originalReject(error);
			};

			this.sendToGuest({ type: "run", cellId, code });
		});
	}

	private settleActiveExecution(active: ActiveExecution): void {
		if (active.settled) return;
		active.settled = true;
		if (this.activeExecution === active) this.activeExecution = undefined;

		// A cancelled cell reports "aborted" even if it happened to finish first:
		// the caller withdrew interest, so the value is not theirs to consume.
		let status = active.status;
		if (active.opts.signal?.aborted) status = "aborted";
		if (status !== "aborted") this.maybeWedged = false;

		const stdout = truncateWithMarker(active.stdout, active.maxChars, active.stdoutTruncated);
		const stderr = truncateWithMarker(active.stderr, active.maxChars, active.stderrTruncated);
		let result = active.result;
		if (result !== undefined && result.length > active.maxChars) {
			result = truncateWithMarker(result, active.maxChars, true);
		}

		active.resolve({
			stdout,
			stderr,
			result,
			error: active.error,
			status,
			durationMs: Date.now() - active.started,
		});
	}

	// ── snapshot / restore / names ─────────────────────────────────────────────

	async snapshotState(): Promise<SnapshotResult | null> {
		const config = this.options.snapshot;
		if (!config || this.state !== "running") return null;
		try {
			const reply = await this.request({ type: "snapshot", id: randomUUID() }, SNAPSHOT_REQUEST_TIMEOUT_MS);
			if (reply.type !== "snapshot_result") return null;
			mkdirSync(dirname(config.path), { recursive: true });
			writeFileSync(config.path, JSON.stringify({ version: 1, vars: reply.vars, failed: reply.failed }));
			return { path: config.path, saved: Object.keys(reply.vars), failed: reply.failed };
		} catch {
			return null;
		}
	}

	async restoreState(): Promise<RestoreResult | null> {
		const config = this.options.snapshot;
		if (!config) return null;
		if (!existsSync(config.path)) return null;
		await this.start();
		try {
			const payload = JSON.parse(readFileSync(config.path, "utf8")) as {
				vars?: Record<string, string>;
			};
			const vars = payload.vars ?? {};
			const reply = await this.request({ type: "restore", id: randomUUID(), vars }, SNAPSHOT_REQUEST_TIMEOUT_MS);
			if (reply.type !== "restore_result") return null;
			return { path: config.path, restored: reply.restored, failed: reply.failed };
		} catch {
			return null;
		}
	}

	async listNamespaceNames(): Promise<string[] | null> {
		if (this.state !== "running") return null;
		try {
			const reply = await this.request({ type: "list_names", id: randomUUID() }, PING_TIMEOUT_MS);
			return reply.type === "names_result" ? reply.names : null;
		} catch {
			return null;
		}
	}

	private scheduleSnapshot(): void {
		const config = this.options.snapshot;
		if (!config) return;
		this.clearSnapshotTimer();
		this.snapshotTimer = setTimeout(() => {
			this.snapshotTimer = undefined;
			void this.snapshotState();
		}, config.debounceMs ?? DEFAULT_SNAPSHOT_DEBOUNCE_MS);
		this.snapshotTimer.unref?.();
	}

	private clearSnapshotTimer(): void {
		if (this.snapshotTimer) {
			clearTimeout(this.snapshotTimer);
			this.snapshotTimer = undefined;
		}
	}
}
