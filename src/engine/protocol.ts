/**
 * Wire protocol between EngineManager (host) and the Bun guest process.
 *
 * Transport: line-delimited JSON over a private loopback socket, never on stdout.
 *
 * Two properties make the channel trustworthy, and both are load-bearing:
 *
 *   1. Separation. The guest's stdout and stderr carry only user output, so a
 *      cell that prints JSON cannot be parsed as protocol traffic. Sharing one
 *      channel would let ordinary output alter the engine's view of a cell.
 *   2. Authentication. Every envelope carries a nonce the host mints at spawn
 *      and the guest erases from its environment before running any cell. Code
 *      inside a cell cannot recover it, so a local socket connection cannot
 *      forge a message.
 *
 * Together they make a cell unable to report its own outcome — it can only run.
 */

export interface HostToGuest {
	run: { type: "run"; cellId: string; code: string };
	abort: { type: "abort"; cellId: string };
	ping: { type: "ping"; id: string };
	host_reply: {
		type: "host_reply";
		id: string;
		status: "ok" | "error";
		payload?: Record<string, unknown>;
		error?: string;
		/** JSON-safe structured fields for capability boundary failures. */
		errorPayload?: Record<string, unknown>;
	};
	snapshot: { type: "snapshot"; id: string };
	restore: {
		type: "restore";
		id: string;
		vars: Record<string, string>;
		/** Per-name age metadata from the snapshot file; absent for v1 files. */
		meta?: Record<string, { touchedAt: number }>;
		/** Cell counter the snapshot was taken at; ages are relative to it. */
		cellSeq?: number;
		/** Values at least this large AND this cold load lazily instead of eagerly. */
		defer?: { minBytes: number; minAgeCells: number };
	};
	list_names: { type: "list_names"; id: string };
}

export type HostToGuestMessage = HostToGuest[keyof HostToGuest];

export interface GuestToHost {
	ready: { type: "ready" };
	stream: { type: "stream"; cellId: string; name: "stdout" | "stderr"; chunk: string };
	done: {
		type: "done";
		cellId: string;
		status: "ok" | "error" | "aborted";
		result?: string;
		error?: { name: string; message: string; stack: string[] };
	};
	pong: { type: "pong"; id: string };
	/**
	 * `cellId` names the cell that issued the request. The host resolves the
	 * abort signal and source attribution from it rather than from whatever cell
	 * happens to be active, because a cancelled cell's continuation can still
	 * reach the bridge after the host has moved on.
	 */
	host_request: {
		type: "host_request";
		id: string;
		cellId: string;
		requestType: string;
		payload: Record<string, unknown>;
	};
	snapshot_result: {
		type: "snapshot_result";
		id: string;
		vars: Record<string, string>;
		/** Names actually re-serialised this time; the rest came from cache. */
		written: string[];
		meta: Record<string, { touchedAt: number }>;
		cellSeq: number;
		failed: { name: string; reason: string }[];
	};
	restore_result: {
		type: "restore_result";
		id: string;
		restored: string[];
		/** Names held serialized, loaded on first read instead of eagerly. */
		deferred: string[];
		failed: { name: string; reason: string }[];
	};
	names_result: { type: "names_result"; id: string; names: string[] };
}

export type GuestToHostMessage = GuestToHost[keyof GuestToHost];

export const ENVELOPE_KEY = "__rlm";
/** Env var carrying the per-process nonce to the guest. */
export const NONCE_ENV = "PI_RLM_NONCE";
/** Env var carrying the host-owned loopback listener port to the guest. */
export const PROTOCOL_PORT_ENV = "PI_RLM_PROTOCOL_PORT";

export function encodeMessage(message: HostToGuestMessage | GuestToHostMessage, nonce?: string): string {
	const envelope: Record<string, unknown> = { [ENVELOPE_KEY]: 1, ...message };
	if (nonce) envelope.n = nonce;
	return `${JSON.stringify(envelope)}\n`;
}

export function decodeMessage<T>(line: string, nonce?: string): T | null {
	if (!line.includes(`"${ENVELOPE_KEY}":1`)) return null;
	try {
		const parsed = JSON.parse(line);
		if (parsed?.[ENVELOPE_KEY] !== 1 || typeof parsed.type !== "string") return null;
		if (nonce && parsed.n !== nonce) return null;
		return parsed as T;
	} catch {
		return null;
	}
}
