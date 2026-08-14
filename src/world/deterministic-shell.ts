import { Effect, Layer } from "effect";
import {
	makeShellExecutionId,
	type ShellExecutionId,
	type ShellTerminalResult,
	type VirtualShellExecRequest,
} from "./domain.js";
import { Shell, type ShellExecutionNotFound, type ShellService } from "./services.js";

export type DeterministicShellEvent =
	| { readonly _tag: "admitted"; readonly executionId: ShellExecutionId; readonly script: string }
	| { readonly _tag: "waited"; readonly executionId: ShellExecutionId };

const emptyOutput = Object.freeze({
	encoding: "base64" as const,
	data: "",
	capturedBytes: 0,
	totalBytes: 0,
	truncated: false,
});

const terminalResult = (executionId: ShellExecutionId): ShellTerminalResult =>
	Object.freeze({
		schemaVersion: 1,
		executionId,
		mode: "virtual",
		profileId: "virtual-tracer-v1",
		started: true,
		queueDurationBucket: "lt_10ms",
		runtimeDurationBucket: "lt_10ms",
		stdout: emptyOutput,
		stderr: emptyOutput,
		sensitivity: "untrusted_output",
		sideEffectsMayHaveOccurred: false,
		cleanup: "not_needed",
		virtualState: Object.freeze({ disposition: "unchanged" }),
		status: Object.freeze({ _tag: "exited", exitCode: 0 }),
	});

const notFound = (): ShellExecutionNotFound => ({
	_tag: "ShellExecutionNotFound",
	code: "SHELL_EXECUTION_NOT_FOUND",
	operation: "shell.wait",
	message: "shell execution was not found",
});

/**
 * Contract tracer for the first World Shell vertical slice.
 *
 * It deliberately executes nothing. The real ambient-free Virtual Environment
 * replaces this adapter; until then the profile identity makes the behavior
 * explicit rather than pretending a model-authored script ran.
 */
export const makeDeterministicShell = () => {
	const records = new Map<ShellExecutionId, ShellTerminalResult>();
	const events: DeterministicShellEvent[] = [];
	let sequence = 0;

	const service: ShellService = {
		virtualExec: (request: VirtualShellExecRequest) =>
			Effect.sync(() => {
				sequence += 1;
				const executionId = makeShellExecutionId(`shell-execution-test-${sequence}`);
				records.set(executionId, terminalResult(executionId));
				events.push({ _tag: "admitted", executionId, script: request.script });
				return { executionId };
			}),
		wait: (request) =>
			Effect.suspend(() => {
				const result = records.get(request.executionId);
				if (!result) return Effect.fail(notFound());
				events.push({ _tag: "waited", executionId: request.executionId });
				return Effect.succeed(result);
			}),
	};

	return { service, events };
};

export const DeterministicShellLive = () => Layer.succeed(Shell)(makeDeterministicShell().service);
