# Security model

This document states the trust boundaries and enforced invariants of the
pi-world extension as currently implemented. It describes what the system
guarantees today, what it deliberately does not attempt, and which risks are
accepted. Deep rationale lives in [ARCHITECTURE.md](ARCHITECTURE.md); domain
vocabulary in [CONTEXT.md](CONTEXT.md).

## Reporting

Report suspected vulnerabilities or boundary escapes to the repository owner
via a GitHub issue marked `needs-triage`, or privately through GitHub's
security advisory feature for this repository.

## Trust boundary: guests never hold authority

The extension exposes one tool, `execute`, running TypeScript in a persistent
Bun evaluator. Everything that evaluator runs is untrusted guest code.

- Guest requests carry operation payloads only. Session ID, cell, depth, and
  principal identity are reconstructed by the bridge from host session context;
  strict schemas reject any authority fields a guest supplies.
- Every World operation passes a default-deny authority check (operation
  allowlist plus recursion-depth limit) before reaching a service.
- Shell Grants are issued host-side only. A guest can name a narrower policy
  profile at spawn; the host proves it component-wise narrower than the parent
  grant before issuing an immutable child grant. The narrowed profile is
  enforced at spawn admission today; transporting derived grants into the
  child's own evaluator is not built yet.
- Shell admission requires an active, non-revoked grant naming the served
  profile, held by the subject's own session, with capacity under the profile's
  concurrency ceiling.

## Shell Grant invariants

Grants are immutable and session-bound. Attenuation is monotonic: operations,
root/network/environment rules, numeric ceilings, and the drain exception must
each be proven narrower than or equal to a profile the parent grant holds.
Profiles are validated (finite in-range integer ceilings) and frozen at
registration; the tracer resolves its served profile from the registry, never
from caller-supplied objects. Revocation cascades to all descendant grants,
refuses admission and delegation, and cancels pending work unless the served
profile explicitly permits bounded drain. Root profiles and root operations are
validated at construction so misconfiguration cannot issue broader authority.

## Audit

Shell admissions are recorded to a durable, fsynced, metadata-only JSONL file
before any allocation. The record contains principal, grant, profile, policy
version, operation, and terminal branch. Scripts, arguments, output,
environment, paths, and causes never reach it. If an admission record cannot be
written, the operation fails with one stable unavailable error and creates no
side effect. Terminal-audit or health-probe failures block further admissions
without rewriting results already delivered, and lifecycle safety actions
(cancellation sweeps) continue during audit outages.

## Resource limits

Policy ceilings bound every Virtual execution: wall-clock timeout, captured
output bytes per stream, and concurrent executions per served profile.
Retention caps stored records by count, age, and combined payload size; output
is erased before metadata under pressure, and captures are bounded base64 of
declared sizes. Ceilings must be finite safe integers; enforcement clamps any
inner adapter setting against them.

## Accepted risks and deliberate exclusions

- **Grant tombstone growth.** Revoked grants stay in in-memory maps for the
  session's life. They are uncapped by design and acceptable while sessions are
  short-lived; revisit if long-lived sessions emerge.
- **Child-grant transport.** Derived child grants are proven at host spawn
  admission but do not yet travel into the child evaluator, so a narrowed child
  is constrained by the admission-time proof rather than carried authority.
- **No isolation from the host user.** Nothing here sandboxes against the OS
  account running pi. The deterministic Virtual tracer executes nothing at all;
  when the real Virtual Environment and Host Shell land, containment will be
  adapter-proven process-tree termination, not POSIX process groups alone.
- **Shutdown scope.** The World runtime closes at session shutdown and admitted
  Pi children are terminated first. The governed shell does not yet have its
  own teardown finalizer; pending shell work belongs to the future Virtual
  Environment slice.
