# Host execution substrate and platform facts

**Ticket:** [#19](https://github.com/aivv73/pi-world/issues/19)  
**Map:** Design the safe shell model for pi-world  
**Research date:** 2026-08-13

## Answer

There are two execution substrates. The Pi extension host is Node and starts the persistent Bun evaluator with Node child_process. World agent children are also started by the host with Node spawn(command, args, options), shell omitted, stdio [ignore, pipe, pipe], and detached true. Production builds explicit argv for pi; shell syntax appears only in injected tests.

The honest portability boundary is structured argv spawning, cwd/env selection, captured stdout/stderr, exit observation, bounded waits, and direct-child cancellation are cross-platform. POSIX process-group cancellation is not. On POSIX, detached spawning creates a new session/process group and negative-PID signalling can target that group. On Windows, Node explicitly says process-group PIDs cannot be used with process.kill; detached means the child can outlive the parent, not that a portable killable process tree exists.

## Primary-source facts

### Bun structured spawn and shell

Bun documents Bun.spawn([command, ...args], options) as an argv-array API returning a Subprocess with pid, streams, exited, exitCode, signalCode, kill(), and optional AbortSignal/timeout support ([Bun child-process docs](https://bun.sh/docs/runtime/child-process), [Bun.spawn reference](https://bun.sh/reference/bun/spawn)). Its reference documents cwd, explicit env, and stdio; stdin ignore/null/undefined means the child has no standard input, while pipe gives an input stream.

Bun Shell is a different primitive: a cross-platform bash-like interpreter with pipes, redirection, globs, native common commands, and interpolation escaped by default ([Bun Shell docs](https://bun.sh/docs/runtime/shell)). It is convenient for scripts, but remains shell-language execution. A safe model must decide whether it exposes this interpreter or only structured argv.

Bun states spawn/spawnSync use posix_spawn(3) under the hood ([Bun child-process docs](https://bun.sh/docs/runtime/child-process)). This does not become a host guarantee: the current Pi host adapter is Node.

### Node host primitives actually used

Node child_process.spawn(command, args, options) documents argv spawning without a shell unless shell is enabled; it supports cwd/env/stdio and emits spawn/exit/close events ([Node child_process docs](https://nodejs.org/api/child_process.html)). This is the primitive used by [src/world/pi-process-agents.ts](../../../src/world/pi-process-agents.ts) and [src/engine/index.ts](../../../src/engine/index.ts).

Production makePiChildSpec passes pi, flags, and the task as separate argv entries. No user task is concatenated into a shell command. The child program itself may still intentionally invoke a shell.

### stdin closure

The world-agent adapter uses stdio [ignore, pipe, pipe]; it exposes no writable stdin to the parent and the child receives no connected input stream. Task enters argv, results leave stdout/stderr, and there is no interactive protocol. Node stdio documentation is the owning source ([Node child_process](https://nodejs.org/api/child_process.html)).

The evaluator differs: its host uses four pipes; the guest reads commands from stdin and its readline close handler exits when that pipe closes ([src/engine/index.ts](../../../src/engine/index.ts), [src/engine/guest.ts](../../../src/engine/guest.ts)). EOF is therefore a lifecycle signal for the evaluator, not an agent cancellation protocol. For agents, stdin is already ignored; cancellation must terminate the process and await close.

### Detached groups and cancellation

Node documents that on non-Windows platforms detached true makes the child leader of a new process group and session; on Windows it permits continuation after parent exit. Detached children still keep the parent waiting unless unref’ed and stdio is disconnected ([Node detached docs](https://nodejs.org/api/child_process.html)). The adapter keeps stdout/stderr pipes and does not unref because it needs completion/output ownership.

POSIX setsid(2) creates a new session and process group, with the caller as group leader ([Linux setsid(2)](https://man7.org/linux/man-pages/man2/setsid.2.html)). POSIX kill(3p) defines a negative pid other than -1 as signalling every permitted process whose process-group ID equals the absolute value ([POSIX kill(3p)](https://man7.org/linux/man-pages/man3/kill.3p.html)). Thus detached plus process.kill(-child.pid, signal) has a principled Linux/macOS group target.

Node states the portability limit directly: Windows throws if a pid is used to kill a process group ([Node process.kill](https://nodejs.org/api/process.html#processkillpid-signal)). Current code checks non-Windows, attempts the negative-pid group signal on POSIX, and falls back to child.kill on Windows ([src/world/pi-process-agents.ts](../../../src/world/pi-process-agents.ts)). Windows fallback is direct-child-only; descendants may survive.

## Local evidence

[test/pi-process-agents.test.ts](../../../test/pi-process-agents.test.ts) establishes: admission returns a handle and close drives completion; wait timeout does not terminate; cancellation sends TERM, waits grace, escalates KILL, and awaits; cancellation is sibling-isolated; nonzero exit differs from cancellation; execution timeout is distinct; shutdown cancels all attached children; managed runtime disposal removes a long-running child.

The test injects sh -c for convenience. That does not prove production uses a shell: spawnCommand is a test seam while makePiChildSpec produces explicit argv. The suite runs on Linux and cannot establish Windows descendant cleanup.

[The engine contract](../../../test/engine.contract.test.ts) establishes Bun.$ as the guest shell, shell cwd as engine cwd, host-owned results/errors, and restart from snapshot. The guest nullish interpolation guard prevents null/undefined becoming literal shell words, but is not a sandbox; the guest retains host filesystem/process authority.

## Honest guarantees

### Cross-platform

- Use an explicit executable plus argv; do not enable Node shell for model-controlled fields.
- Set cwd/env explicitly; classify lookup, permission, missing-cwd, and spawn errors.
- Capture stdout/stderr separately, cap output, observe completion, and distinguish exit code, signal, timeout, and caller cancellation.
- Close/ignore stdin deliberately. EOF is not cancellation.
- Cancel the direct child and await close. TERM/grace/KILL is best effort.
- Own admitted World agents at session scope; cell completion must not kill an admitted child.

### POSIX-only or best effort

- Whole-tree cancellation via detached plus negative-PID signalling. This is not Windows-portable.
- The child cannot outlive cancellation: descendants can daemonize, create another session, escape the group, ignore TERM, or exceed permissions.
- EOF cancels work: EOF only informs a reader its input ended.
- Bun.spawn semantics apply to the Node host: they do not.
- Bun Shell is a security sandbox: escaping protects interpolated strings, not host authority.

## Decision/prototype fog for the parent map

1. Choose a shell contract: structured argv only, Bun Shell scripts, or both with visibly distinct capabilities. Bun.$ is powerful host execution, not isolation.
2. Define Windows policy: accept direct-child-only cancellation, add a Windows-specific tree/job-object implementation, or declare POSIX-only process-tree guarantees. Do not call the fallback tree cancellation.
3. Define executable resolution: absolute allowlist versus PATH; production currently relies on PATH (pi).
4. Define resource limits: current adapter caps output and time but has no CPU, memory, filesystem, network, or child-count sandbox.
5. Prototype descendant-spawn/cancel on Linux, macOS, and Windows, including a TERM-ignoring descendant and a daemonizing descendant. Current Linux tests prove intended behavior, not cross-platform equivalence.

## Source index

- [src/world/pi-process-agents.ts](../../../src/world/pi-process-agents.ts) — production spawn, stdio, detached signalling, TERM/grace/KILL, close completion.
- [src/engine/index.ts](../../../src/engine/index.ts) and [src/engine/guest.ts](../../../src/engine/guest.ts) — Bun guest lifecycle and stdin EOF.
- [test/pi-process-agents.test.ts](../../../test/pi-process-agents.test.ts) — process lifecycle contract.
- [test/engine.contract.test.ts](../../../test/engine.contract.test.ts) — evaluator shell/lifecycle contract.
- [Bun child processes](https://bun.sh/docs/runtime/child-process), [Bun.spawn](https://bun.sh/reference/bun/spawn), [Bun Shell](https://bun.sh/docs/runtime/shell).
- [Node child_process](https://nodejs.org/api/child_process.html), [Node process.kill](https://nodejs.org/api/process.html#processkillpid-signal).
- [POSIX/Linux setsid](https://man7.org/linux/man-pages/man2/setsid.2.html), [POSIX kill](https://man7.org/linux/man-pages/man3/kill.3p.html).

## Reproducibility

Observed host: Bun 1.3.14, Node v26.4.0, Linux x86_64. Bun-facing types are pinned to 1.3.14 in bun.lock; package metadata requires Bun >=1.0.0. Platform claims derive from cited upstream specifications, not from treating this Linux run as Windows evidence.