import { Effect, Layer } from "effect";
import { isShellOperation, type WorldOperation, type WorldSubject } from "./domain.js";
import { Authority, type AuthorityService, type ShellAuthorityDenied, type WorldDenied } from "./services.js";

export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_ALLOWED_OPERATIONS: readonly WorldOperation[] = [
	"agents.spawn",
	"agents.wait",
	"agents.cancel",
	"web.search",
	"shell.virtual.exec",
	"shell.wait",
	"shell.cancel",
	"shell.attach",
];

export interface StaticAuthorityOptions {
	readonly maxDepth?: number;
	readonly allowedOperations?: readonly WorldOperation[];
}

const denied = (operation: WorldOperation, message: string): WorldDenied | ShellAuthorityDenied =>
	isShellOperation(operation)
		? { _tag: "ShellAuthorityDenied", code: "SHELL_AUTHORITY_DENIED", operation, message }
		: { _tag: "WorldDenied", code: "WORLD_ACCESS_DENIED", operation, message };

export const makeStaticAuthority = (options: StaticAuthorityOptions = {}): AuthorityService => {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const allowed = new Set(options.allowedOperations ?? DEFAULT_ALLOWED_OPERATIONS);

	return {
		check: (subject: WorldSubject, operation: WorldOperation) =>
			Effect.suspend(() => {
				if (!allowed.has(operation)) {
					return Effect.fail(denied(operation, `world operation ${operation} is not granted`));
				}
				if (operation === "agents.spawn" && subject.depth >= maxDepth) {
					return Effect.fail(denied(operation, `agent depth limit (${maxDepth}) reached`));
				}
				return Effect.succeed(undefined);
			}),
	};
};

export const StaticAuthorityLive = (options: StaticAuthorityOptions = {}) =>
	Layer.succeed(Authority)(makeStaticAuthority(options));
