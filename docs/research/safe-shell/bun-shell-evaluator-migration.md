# Bun.$ and evaluator migration surface

Issue [#17](https://github.com/aivv73/pi-world/issues/17), investigated against pi-world commit c50fb463a8c21dea6471b523505d07dea593f8f0 and Bun 1.3.14 (upstream release commit 0d9b296af33f2b851fcbf4df3e9ec89751734ba4). This characterizes the current contract; it does not implement a replacement shell.

## Executive answer

The evaluator exposes Bun Shell, not POSIX /bin/sh. A cell reaches a guarded proxy around the guest's global Bun.$; the proxy rejects null/undefined interpolations, then delegates all other behavior to Bun 1.3.14. Bun Shell parses a bash-like language in-process, escapes interpolated values as single literal arguments by default, supports pipelines/redirections/globs/command substitution/environment and cwd controls, and executes external programs where needed. Awaiting normally rejects on non-zero exit; .nothrow().quiet() yields buffered {stdout, stderr, exitCode}. These are compatibility obligations, not incidental syntax.

Bun's primary [Shell docs](https://bun.sh/docs/runtime/shell) say it is a cross-platform reimplementation rather than a system shell, interpolation is injection-safe but does not prevent argument/flag injection, {raw: ...} bypasses escaping, and Bun Shell operations can run concurrently. The pinned [Bun v1.3.14 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14) identifies source commit 0d9b296. Primary implementation links: [interpreter](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/shell/interpreter.zig), [lexer/parser](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/shell/shell.zig), [API binding](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/api/Shell.classes.ts).

## Current evaluator contract

* src/engine/guest.ts:277-313 creates guardShellInterpolation(Bun.$), installs it as engine-owned Bun, and preserves the rest of Bun through a receiver-bound proxy. The guard runs before Bun builds a command and throws a cell TypeError naming interpolation number and nullish value. [Source](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/src/engine/guest.ts#L277-L313)
* The guest replaces stdout/stderr and console methods with cell-attributed protocol streams. An unquiet shell call therefore streams command output into the cell transcript; .quiet() or .text() is required when output should remain a value. [Source](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/src/engine/guest.ts#L200-L250)
* Engine cells are serialized, but Bun Shell's own interpreter documents concurrent shell operations within a script. A migration must not accidentally change ordering, pipeline/redirection semantics, or process lifetime.
* The engine cwd is the shell cwd; shell-local cd, exports, and variables do not persist between calls. The prompt explicitly teaches this and directs persistent changes to process.chdir/process.env. [Prompt](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/src/extension/prompt.ts#L59-L68)
* Cancellation is evaluator-level and cooperative. A cell waiting on a shell promise can be aborted, but synchronous infinite code cannot yield; a replacement must define subprocess cancellation, orphan handling, and descendant lifetime. Existing contracts require bounded abort settlement, no post-abort stream attribution, and kill/restore recovery. [Contracts](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/test/engine.contract.test.ts#L225-L384)

## Bun Shell API and failures

Direct project use is small: tagged templates, .quiet(), .nothrow(), stdout/stderr/exitCode, and Bun.$.escape. Bun's API reference additionally defines .text(), .json(), .lines(), .arrayBuffer(), .blob(), .throws(), .cwd(), .env(), $.escape, $.braces, stdin/stdout objects, and raw expressions. Compatibility must preserve or explicitly remove each exposed capability. The current guard only checks nullish values; it does not constrain raw objects, command text, command names, filesystem, network, environment, or flags.

Bun's docs establish: default non-zero exit is ShellError carrying exit code and captured output; .nothrow() changes it to a value requiring exitCode checking; parser/missing-command failures remain command failures; interpolated strings are shell-escaped, but bash -c plus interpolation reintroduces shell interpretation; and a string can still be a malicious program argument such as a git option. Escaping is not authorization.

## Complete local migration inventory

* Runtime: [guest.ts](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/src/engine/guest.ts#L1-L630) imports bun:jsc, uses Bun.$ and Bun.inspect, and relies on Bun globals. A Node evaluator migration therefore needs equivalents for serialization, inspection, npm import/cache behavior, guest bootstrap, and runtime entrypoints—not just a shell replacement.
* Host/engine: [engine/index.ts](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/src/engine/index.ts) starts the Bun guest and owns cwd/env, stream attribution, queueing, abort/kill, and snapshots. A replacement belongs behind this boundary.
* Model-visible descriptions: [extension/index.ts](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/src/extension/index.ts#L243-L251), [prompt.ts](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/src/extension/prompt.ts#L59-L92), [README.md](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/README.md#L45-L54), and ARCHITECTURE.md teach Bun.$, shell values, quiet/nothrow, fresh subshells, and interpolation re-verification.
* Tests/UI: [engine.contract.test.ts](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/test/engine.contract.test.ts#L202-L223) pins persistent output/exit code and cwd; lines 1250-1297 pin null/undefined rejection, pre-build failure, partial binding persistence, falsy values, and untouched Bun APIs. [units.test.ts](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/test/units.test.ts#L235-L255) pins prompt language; [preview-core.test.ts](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/test/preview-core.test.ts#L1-L140) and [render-core.ts](https://github.com/aivv73/pi-world/blob/c50fb463a8c21dea6471b523505d07dea593f8f0/src/extension/render-core.ts#L55-L65) classify Bun.$ cells.

Repository search found Bun.$ references in guest/engine contracts, prompt/index, preview/render, README/architecture, and tests; no World service directly depends on it. Host tools.bash is a separate host-side schema/timeout/output boundary and is not a drop-in semantic replacement.

## Safe migration acceptance checklist

1. Name the contract: retain Bun Shell, provide a compatibility facade, or intentionally remove it. Do not call POSIX or virtual-shell behavior compatible without a matrix.
2. Add differential tests for interpolation (including nullish, falsy, nested, raw), grammar (pipes, redirects, globs, substitutions, quoting), env/cwd, output/streaming, exit/error shape, quiet/nothrow, and missing commands.
3. Preserve cell attribution, serialized evaluator execution, abort signals, output caps, child-death settlement, and orphan-process cleanup.
4. Keep authority behind evaluator/host boundaries. Decide cwd roots, environment allowlists, executable/argument policy, network/filesystem policy, resource/time/output limits, and raw policy. Bun interpolation escaping is not a sandbox.
5. Update guest bootstrap/types, engine lifecycle, package/runtime requirements, tool descriptions, prompt, README/ARCHITECTURE, preview/render classifiers, direct tests, comparison fixtures, and generated examples. Search Bun.$, Bun, bun:, shell markers, and fresh-subshell wording after implementation.
6. Decide whether old snapshots/cells resume. Persist plain command/result data only; live ShellPromise/process handles are not resumable.
7. Run bun run check and a platform matrix; include Node-host/Bun-guest lifecycle tests and descendant cleanup.

## Decision/prototype fog exposed

* “Safe shell” could mean a policy-enforced host capability, an in-memory virtual shell, or a Bun-compatible facade; these differ in filesystem, executable, network, and cwd semantics.
* argv-first commands avoid grammar emulation but break generated cells and shell composition idioms. Preserving Bun grammar has a large compatibility surface.
* The nullish guard is a stale-variable safeguard, not authorization. Raw interpolation, allowlists, inherited environment, cwd confinement, timeouts, output caps, and process-group cleanup remain decisions.
* Tests do not fully pin .env/.cwd/.throws, raw interpolation, command substitution, globs, or descendant cleanup; these need prototypes before claiming compatibility.
* Bun 1.3.14 is the observed runtime. Upgrades can change shell behavior, so pin the runtime or maintain a versioned compatibility suite.

## Verification

bun run check was attempted in the isolated worktree. It was blocked before tests/lint because dependencies are not installed: tsc: command not found (exit 127). No source files were changed.
