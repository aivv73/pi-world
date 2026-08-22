import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { Effect } from "effect";
import {
	DEFAULT_OUTPUT_CAPTURE_BYTES,
	type DeterministicShellOptions,
	makeDeterministicShell,
} from "./deterministic-shell.js";
import {
	type GrantId,
	makeGrantId,
	makePrincipalId,
	type PrincipalId,
	type ShellExecutionId,
	type ShellOperation,
	type ShellStatus,
	type WorldSubject,
} from "./domain.js";
import type {
	ShellAuthorityDenied,
	ShellExecutionNotFound,
	ShellService,
	ShellUnavailableError,
	WorldDenied,
} from "./services.js";

/**
 * A host-established identity for one session root or agent. Every field is
 * derived from host session context; nothing here is ever read from a guest.
 */
export interface AgentPrincipal {
	readonly principalId: PrincipalId;
	readonly sessionId: string;
	readonly depth: number;
	/** Ancestor principals, nearest first; a session root has none. */
	readonly lineage: readonly PrincipalId[];
}

/** Numeric ceilings a profile caps; a child ceiling must be narrower or equal. */
export interface PolicyCeilings {
	readonly executionTimeoutMs: number;
	readonly outputBytes: number;
	readonly concurrentExecutions: number;
}

/**
 * A policy-owned, versioned shell identity. Every component participates in
 * the narrowing proof, so a child profile cannot widen any dimension.
 */
export interface PolicyProfile {
	readonly profileId: string;
	readonly policyVersion: number;
	readonly mode: "virtual";
	/** Shell operations this profile admits; anything omitted denies. */
	readonly operations: readonly ShellOperation[];
	// v1 Virtual tracer rules are closed literals; real rule sets widen these
	// into comparable rule lists without changing the proof shape.
	readonly network: "none";
	readonly environment: "none";
	readonly root: "virtual";
	readonly ceilings: PolicyCeilings;
	/** Whether work admitted under this profile may drain bounded when its grant is revoked. */
	readonly drainOnRevocation: boolean;
}

/**
 * An immutable, host-owned binding of one principal to named profiles and
 * operations. Grants are never mutated: revocation is a separate tombstone.
 */
export interface ShellGrant {
	readonly grantId: GrantId;
	readonly principalId: PrincipalId;
	/** The issuing session; a grant never authorizes work under another session's subject. */
	readonly sessionId: string;
	readonly parentGrantId: GrantId | undefined;
	readonly lineage: readonly PrincipalId[];
	readonly policyVersion: number;
	readonly profiles: readonly string[];
	readonly operations: readonly ShellOperation[];
}

export interface ProfileRegistry {
	readonly version: number;
	readonly lookup: (profileId: string) => PolicyProfile | undefined;
}

// A profile is authority: the registry copies and freezes every level so a
// later caller-side mutation cannot widen grants that were already issued.
export const makeProfileRegistry = (profiles: readonly PolicyProfile[]): ProfileRegistry => {
	const byId = new Map(
		profiles.map((profile) => {
			const frozen: PolicyProfile = Object.freeze({
				...profile,
				operations: Object.freeze([...profile.operations]),
				ceilings: Object.freeze({ ...profile.ceilings }),
			});
			return [frozen.profileId, frozen] as const;
		}),
	);
	const version = profiles.reduce((max, profile) => Math.max(max, profile.policyVersion), 1);
	return { version, lookup: (profileId) => byId.get(profileId) };
};

/** The one profile the deterministic Virtual tracer serves. */
export const VIRTUAL_TRACER_PROFILE: PolicyProfile = Object.freeze({
	profileId: "virtual-tracer-v1",
	policyVersion: 1,
	mode: "virtual",
	operations: Object.freeze<readonly ShellOperation[]>([
		"shell.virtual.exec",
		"shell.wait",
		"shell.cancel",
		"shell.attach",
	]),
	network: "none",
	environment: "none",
	root: "virtual",
	ceilings: Object.freeze({ executionTimeoutMs: 60_000, outputBytes: 131_072, concurrentExecutions: 16 }),
	drainOnRevocation: false,
});

export const DEFAULT_VIRTUAL_PROFILES: readonly PolicyProfile[] = Object.freeze([VIRTUAL_TRACER_PROFILE]);

const isSubset = <T>(child: readonly T[], parent: readonly T[]): boolean =>
	child.every((item) => parent.includes(item));

// Monotonic attenuation: every component of the child profile — operations,
// root, network rule, environment rule, each numeric ceiling, and the drain
// exception — must be proven narrower than or equal to the parent profile.
const isNarrowerOrEqual = (child: PolicyProfile, parent: PolicyProfile): boolean =>
	child.mode === parent.mode &&
	child.root === parent.root &&
	child.network === parent.network &&
	child.environment === parent.environment &&
	isSubset(child.operations, parent.operations) &&
	child.ceilings.executionTimeoutMs <= parent.ceilings.executionTimeoutMs &&
	child.ceilings.outputBytes <= parent.ceilings.outputBytes &&
	child.ceilings.concurrentExecutions <= parent.ceilings.concurrentExecutions &&
	(!child.drainOnRevocation || parent.drainOnRevocation);

export interface ShellGrantsService {
	/** Issues the least-authority Virtual-only grant for a session root principal. */
	readonly issueRoot: (principal: AgentPrincipal) => ShellGrant;
	readonly activeFor: (principalId: PrincipalId) => ShellGrant | undefined;
	/**
	 * Proves the requested named profile is component-wise narrower than or
	 * equal to a profile the parent grant holds, then issues an immutable
	 * child grant for a fresh child principal. Anything else denies.
	 */
	readonly attenuate: (
		parent: Pick<AgentPrincipal, "principalId" | "sessionId" | "depth">,
		requestedProfileId: string,
	) => Effect.Effect<ShellGrant, WorldDenied>;
	/** Revokes the grant and cascades to every descendant grant; idempotent. */
	readonly revoke: (grantId: GrantId) => readonly GrantId[];
	readonly onRevocation: (listener: (revoked: readonly GrantId[]) => void) => void;
}

export interface ShellGrantsOptions {
	readonly registry: ProfileRegistry;
	readonly rootProfiles?: readonly string[];
	readonly rootOperations?: readonly ShellOperation[];
}

// Spawn-time attenuation failures are agents.spawn authority denials; the
// shell operation denials keep their own tags inside the enforced shell.
const deniedEffect = (message: string) =>
	Effect.fail<WorldDenied>({ _tag: "WorldDenied", code: "WORLD_ACCESS_DENIED", operation: "agents.spawn", message });

export const makeShellGrants = (options: ShellGrantsOptions): ShellGrantsService => {
	const registry = options.registry;
	const rootProfiles = options.rootProfiles ?? [VIRTUAL_TRACER_PROFILE.profileId];
	const rootOperations = options.rootOperations ?? [...VIRTUAL_TRACER_PROFILE.operations];
	// Root configuration is host-side authority, so an invalid definition is a
	// programming error, not a runtime denial: fail before any grant exists.
	for (const profileId of rootProfiles) {
		if (registry.lookup(profileId) === undefined) {
			throw new Error("root shell profile is not in the registry: " + profileId);
		}
	}
	const heldOperations = new Set(rootProfiles.flatMap((profileId) => registry.lookup(profileId)?.operations ?? []));
	for (const operation of rootOperations) {
		if (!heldOperations.has(operation)) {
			throw new Error("root operation is not granted by any root profile: " + operation);
		}
	}
	const grants = new Map<GrantId, { grant: ShellGrant; revoked: boolean }>();
	const byPrincipal = new Map<PrincipalId, GrantId>();
	const listeners: Array<(revoked: readonly GrantId[]) => void> = [];

	const register = (grant: ShellGrant) => {
		grants.set(grant.grantId, { grant, revoked: false });
		byPrincipal.set(grant.principalId, grant.grantId);
		return grant;
	};

	return {
		issueRoot: (principal) =>
			register(
				Object.freeze({
					grantId: makeGrantId("grant-" + randomUUID()),
					principalId: principal.principalId,
					sessionId: principal.sessionId,
					parentGrantId: undefined,
					lineage: Object.freeze([...principal.lineage]),
					policyVersion: registry.version,
					profiles: Object.freeze([...rootProfiles]),
					operations: Object.freeze([...rootOperations]),
				}),
			),
		activeFor: (principalId) => {
			const grantId = byPrincipal.get(principalId);
			if (grantId === undefined) return undefined;
			const entry = grants.get(grantId);
			return entry !== undefined && !entry.revoked ? entry.grant : undefined;
		},
		attenuate: (parent, requestedProfileId): Effect.Effect<ShellGrant, WorldDenied> =>
			Effect.suspend(() => {
				const parentGrantId = byPrincipal.get(parent.principalId);
				const parentEntry = parentGrantId === undefined ? undefined : grants.get(parentGrantId);
				if (parentEntry === undefined || parentEntry.revoked) {
					return deniedEffect("no active shell grant attenuates");
				}
				// The grant stays bound to its issuing session even if a forged or
				// recycled subject presents the right principal ID.
				if (parentEntry.grant.sessionId !== parent.sessionId) {
					return deniedEffect("the parent shell grant belongs to another session");
				}
				const requested = registry.lookup(requestedProfileId);
				if (requested === undefined) {
					return deniedEffect("the requested shell profile is unknown");
				}
				// The child profile must be proven narrower than a profile the
				// parent actually holds; the name alone carries no authority.
				const holdsNarrower = parentEntry.grant.profiles.some((profileId) => {
					const held = registry.lookup(profileId);
					return held !== undefined && isNarrowerOrEqual(requested, held);
				});
				if (!holdsNarrower) {
					return deniedEffect("the requested shell profile is not narrower than the parent grant");
				}
				return Effect.succeed(
					register(
						Object.freeze({
							grantId: makeGrantId("grant-" + randomUUID()),
							principalId: makePrincipalId("principal-" + randomUUID()),
							sessionId: parentEntry.grant.sessionId,
							parentGrantId: parentEntry.grant.grantId,
							lineage: Object.freeze([parent.principalId, ...parentEntry.grant.lineage]),
							policyVersion: registry.version,
							profiles: Object.freeze([requested.profileId]),
							// Least authority even inside the narrower profile: the
							// child never receives an operation the parent lacks.
							operations: Object.freeze(
								requested.operations.filter((operation) => parentEntry.grant.operations.includes(operation)),
							),
						}),
					),
				);
			}),
		revoke: (grantId) => {
			const entry = grants.get(grantId);
			if (entry === undefined || entry.revoked) return [];
			const revokePrincipalId = entry.grant.principalId;
			const revoked: GrantId[] = [];
			for (const [id, candidate] of grants) {
				if (candidate.revoked) continue;
				if (id === grantId || candidate.grant.lineage.includes(revokePrincipalId)) {
					candidate.revoked = true;
					revoked.push(id);
				}
			}
			for (const listener of listeners) listener(revoked);
			return revoked;
		},
		onRevocation: (listener) => {
			listeners.push(listener);
		},
	};
};

export interface ShellAuditAdmission {
	readonly principalId: PrincipalId;
	readonly grantId: GrantId;
	readonly profileId: string;
	readonly policyVersion: number;
	readonly operation: ShellOperation;
}

export interface ShellAuditTerminal {
	readonly executionId: ShellExecutionId;
	readonly principalId: PrincipalId;
	readonly grantId: GrantId;
	readonly profileId: string;
	readonly branch: ShellStatus["_tag"];
}

export interface ShellAuditService {
	/**
	 * Durably records one admission before any allocation. Throws when the
	 * record cannot be written; the caller must refuse the admission with the
	 * stable unavailable error and create no side effect.
	 */
	readonly admit: (entry: ShellAuditAdmission) => void;
	/**
	 * Best effort: a failed terminal record marks the service unhealthy
	 * instead of rewriting a result that was already delivered.
	 */
	readonly terminal: (entry: ShellAuditTerminal) => void;
	readonly revocation: (revoked: readonly GrantId[]) => void;
	readonly healthy: () => boolean;
}

// Metadata only: principal, grant, profile, operation, and outcome identity.
// Scripts, arguments, output, environment, paths, and causes must never reach
// the audit stream (enforced by privacy-pair tests).
export const makeFileShellAudit = (options: { readonly path: string }): ShellAuditService => {
	mkdirSync(dirname(options.path), { recursive: true });
	let sequence = 0;
	let unhealthy = false;
	const append = (entry: Record<string, unknown>) => {
		sequence += 1;
		const line = JSON.stringify({ seq: sequence, ts: new Date().toISOString(), ...entry }) + "\n";
		const fd = openSync(options.path, "a");
		try {
			writeSync(fd, line);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	};
	return {
		admit: (entry) => {
			if (unhealthy) throw new Error("shell audit is unhealthy");
			append({
				kind: "admission",
				principalId: entry.principalId,
				grantId: entry.grantId,
				profileId: entry.profileId,
				policyVersion: entry.policyVersion,
				operation: entry.operation,
			});
		},
		terminal: (entry) => {
			try {
				append({
					kind: "terminal",
					executionId: entry.executionId,
					principalId: entry.principalId,
					grantId: entry.grantId,
					profileId: entry.profileId,
					branch: entry.branch,
				});
			} catch {
				unhealthy = true;
			}
		},
		revocation: (revoked) => {
			try {
				append({ kind: "revocation", grants: [...revoked] });
			} catch {
				// A revocation that cannot be audited has already taken effect;
				// the in-memory tombstones are the authority.
			}
		},
		healthy: () => !unhealthy,
	};
};

interface TrackedAdmission {
	readonly executionId: ShellExecutionId;
	readonly grantId: GrantId;
	readonly principalId: PrincipalId;
	/** The admitting principal's ancestors: explicitly granted supervisors. */
	readonly ownerLineage: readonly PrincipalId[];
	readonly subject: WorldSubject;
}

export interface GrantEnforcedTracerOptions {
	readonly grants: ShellGrantsService;
	readonly audit: ShellAuditService;
	readonly profile: PolicyProfile;
	readonly tracerOptions?: DeterministicShellOptions;
}

const notFound = (operation: "shell.wait" | "shell.cancel" | "shell.attach"): ShellExecutionNotFound => ({
	_tag: "ShellExecutionNotFound",
	code: "SHELL_EXECUTION_NOT_FOUND",
	operation,
	// Owner, ancestor, sibling, descendant, and unknown failures all read
	// identically so access cannot be enumerated through the error channel.
	message: "shell execution was not found",
});

const unavailable = (operation: "shell.virtual.exec"): ShellUnavailableError => ({
	_tag: "ShellUnavailableError",
	code: "SHELL_UNAVAILABLE",
	operation,
	message: "the shell service is unavailable",
});

const admissionDenied = (operation: "shell.virtual.exec"): ShellAuthorityDenied => ({
	_tag: "ShellAuthorityDenied",
	code: "SHELL_AUTHORITY_DENIED",
	operation,
	message: "the shell operation is not granted",
});

/**
 * The deterministic tracer behind host-owned principals and grants: admission
 * requires an active grant naming the served profile and a durable audit
 * record that precedes allocation; wait, cancel, and attach require the owner
 * or an explicitly granted ancestor; revocation cascades and cancels pending
 * work unless the served profile permits bounded drain.
 */
export const makeGrantEnforcedTracer = (deps: GrantEnforcedTracerOptions) => {
	const admissions = new Map<ShellExecutionId, TrackedAdmission>();
	// An immediate (zero-delay) settlement fires the terminal observer while
	// the admission is still inside the inner call; buffer until registration.
	const earlyTerminals = new Map<ShellExecutionId, ShellStatus["_tag"]>();
	// The audit service reports its own health, but a terminal write that
	// escapes as a thrown error would break settlement and retention from a
	// timer callback; contain it here and refuse further admissions locally.
	let terminalAuditHealthy = true;

	const writeTerminalAudit = (executionId: ShellExecutionId, branch: ShellStatus["_tag"]) => {
		const admission = admissions.get(executionId);
		if (admission === undefined) return;
		try {
			deps.audit.terminal({
				executionId,
				principalId: admission.principalId,
				grantId: admission.grantId,
				profileId: deps.profile.profileId,
				branch,
			});
		} catch {
			terminalAuditHealthy = false;
		}
	};

	// The served profile bounds whatever the inner options declare: the
	// narrowing proof would be paper-only if a wider adapter setting won.
	const tracerOptions: DeterministicShellOptions = {
		...deps.tracerOptions,
		executionTimeoutMs: Math.min(
			deps.tracerOptions?.executionTimeoutMs ?? Number.POSITIVE_INFINITY,
			deps.profile.ceilings.executionTimeoutMs,
		),
		captureBytesCap: Math.min(
			deps.tracerOptions?.captureBytesCap ?? DEFAULT_OUTPUT_CAPTURE_BYTES,
			deps.profile.ceilings.outputBytes,
		),
	};

	const tracer = makeDeterministicShell({
		...tracerOptions,
		onTerminal: (event) => {
			// The terminal audit fires once; the tracking entry stays until the
			// inner record is evicted so post-settlement waits keep converging.
			const admission = admissions.get(event.executionId);
			if (admission === undefined) {
				earlyTerminals.set(event.executionId, event.branch);
				return;
			}
			writeTerminalAudit(event.executionId, event.branch);
		},
		onDropped: (executionId) => {
			admissions.delete(executionId);
		},
	});

	deps.grants.onRevocation((revoked) => {
		// The in-memory tombstones are already in force before this listener
		// runs, so an audit outage must never skip the cancellation sweep.
		try {
			deps.audit.revocation(revoked);
		} catch {
			// Lifecycle safety continues without the record.
		}
		const revokedSet = new Set(revoked);
		for (const [executionId, admission] of [...admissions]) {
			if (!revokedSet.has(admission.grantId)) continue;
			// A predefined safe profile may drain bounded; everything else is
			// cancelled through the inner adapter as a system action.
			if (deps.profile.drainOnRevocation) continue;
			void Effect.runPromise(tracer.service.cancel({ executionId }, admission.subject)).catch(() => {});
		}
	});

	const accessDenied = (subject: WorldSubject, admission: TrackedAdmission, operation: ShellOperation): boolean => {
		const isOwner = subject.principalId === admission.principalId;
		const grant = deps.grants.activeFor(subject.principalId);
		if (isOwner) {
			// An active grant governs every operation, omitted ones included.
			if (grant !== undefined) return !grant.operations.includes(operation);
			// A revoked owner keeps observing its own work — waiting cannot
			// escalate — while cancellation and attachment stay blocked.
			return operation !== "shell.wait";
		}
		// An explicitly granted ancestor supervises; a sibling, a descendant,
		// or a revoked supervisor denies like any unknown ID.
		return (
			grant === undefined ||
			!grant.operations.includes(operation) ||
			!admission.ownerLineage.includes(subject.principalId)
		);
	};

	const service: ShellService = {
		virtualExec: (request, subject) =>
			Effect.suspend(() => {
				if (!deps.audit.healthy() || !terminalAuditHealthy) {
					return Effect.fail(unavailable("shell.virtual.exec"));
				}
				const grant = deps.grants.activeFor(subject.principalId);
				if (
					grant === undefined ||
					!grant.operations.includes("shell.virtual.exec") ||
					!grant.profiles.includes(deps.profile.profileId)
				) {
					return Effect.fail(admissionDenied("shell.virtual.exec"));
				}
				// Capacity is not an authority denial: the stable unavailable
				// error keeps the concurrency limit out of the error channel.
				if (tracer.pendingCount() >= deps.profile.ceilings.concurrentExecutions) {
					return Effect.fail(unavailable("shell.virtual.exec"));
				}
				try {
					// The durable record precedes allocation: if it cannot be
					// written, nothing is created and the failure is stable.
					deps.audit.admit({
						principalId: subject.principalId,
						grantId: grant.grantId,
						profileId: deps.profile.profileId,
						policyVersion: grant.policyVersion,
						operation: "shell.virtual.exec",
					});
				} catch {
					return Effect.fail(unavailable("shell.virtual.exec"));
				}
				return Effect.gen(function* () {
					const handle = yield* tracer.service.virtualExec(request, subject);
					admissions.set(handle.executionId, {
						executionId: handle.executionId,
						grantId: grant.grantId,
						principalId: subject.principalId,
						ownerLineage: grant.lineage,
						subject,
					});
					const earlyBranch = earlyTerminals.get(handle.executionId);
					if (earlyBranch !== undefined) {
						earlyTerminals.delete(handle.executionId);
						writeTerminalAudit(handle.executionId, earlyBranch);
					}
					return handle;
				});
			}),
		wait: (request, subject) => {
			const admission = admissions.get(request.executionId);
			if (admission === undefined || accessDenied(subject, admission, "shell.wait")) {
				return Effect.fail(notFound("shell.wait"));
			}
			return tracer.service.wait(request, subject);
		},
		cancel: (request, subject) => {
			const admission = admissions.get(request.executionId);
			if (admission === undefined || accessDenied(subject, admission, "shell.cancel")) {
				return Effect.fail(notFound("shell.cancel"));
			}
			return tracer.service.cancel(request, subject);
		},
		attach: (request, subject) => {
			const admission = admissions.get(request.executionId);
			if (admission === undefined || accessDenied(subject, admission, "shell.attach")) {
				return Effect.fail(notFound("shell.attach"));
			}
			return tracer.service.attach(request, subject);
		},
	};

	return { service, events: tracer.events, pendingCount: tracer.pendingCount, recordCount: tracer.recordCount };
};
