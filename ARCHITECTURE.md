# Architecture

## Shape

Two processes. The host lives inside pi; the guest owns the namespace.

```
pi
 └─ extension             always exposes execute; owns the Pi session
     ├─ SessionWorldOwner one ManagedRuntime and Agents scope per session
     └─ EngineManager     replaceable evaluator generation, queue, snapshots
         │  stdin   ──▶   commands
         │ loopback ◀──   protocol: results, output, host requests
         │  stdout  ◀──   subprocess output only
         └─ guest (bun)   namespace, cell execution, host bridge
```

Splitting them is what makes the evaluator survivable. A cell can wedge the
guest, exhaust its memory, or kill it outright without taking pi down, and the
host can always report what happened because it is not the thing that failed.

## A cell, end to end

1. The tool hands `EngineManager.execute` the cell source.
2. The manager claims the execution slot **synchronously**, before its first
   await, so concurrent callers run in submission order rather than in whatever
   order their startup happened to finish.
3. The guest transforms the source: types stripped, top-level declarations
   rewritten to assignments, imports rewritten to awaited dynamic imports
   (`npm:` specifiers route through the guest's lazy install cache instead,
   since Bun's runtime cannot resolve them), and a trailing expression captured
   as the result.
4. The body runs inside `with (proxy)` in an async function. Ordinary
   assignments become namespace entries; ordinary reads resolve against the
   namespace, then the global scope.
5. Output is tagged with the cell that produced it and streamed to the host as
   it happens.
6. The guest reports completion. The host applies output caps, decides the final
   status, and schedules a snapshot if the cell succeeded.

## Invariants

These are the promises the engine makes. Each is pinned by a test in
`test/engine.contract.test.ts`.

**One cell at a time, in submission order.** There is one namespace; interleaved
cells would make results depend on timing rather than on the program.

**Output belongs to its cell.** Every write is attributed to the cell that
produced it, including writes from a continuation that outlives its cell. Output
that belongs to no cell is discarded rather than assigned to whichever cell
happens to be running.

**A cell cannot report its own outcome.** Status, results, and errors reach the
host only through an authenticated channel a cell cannot write to.

**Bindings are incremental.** A cell is a sequence of bindings, not a
transaction. Names bound before a failure stay bound, and closures observe later
rebinding rather than a snapshot from their own cell.

**Cancellation costs one cell.** The namespace survives, and the cancelled
cell's continuation cannot write to it or keep streaming output.

**Durability is automatic and honest.** Successful cells schedule a snapshot;
nothing depends on remembering to save. Values that cannot be serialised are
reported by name.

**Teardown fails loudly.** Every call against a stopped engine rejects
immediately. Nothing hangs.

## Decisions

### The namespace is a proxy, and declarations become assignments

Cells run inside `with (proxy)`, so unqualified reads and writes go through the
namespace. But a top-level `let x = 1` inside that block creates a *local*
binding in the wrapper function, not a namespace entry — which produces two bad
behaviours: a closure captures the local and never sees later updates, and
nothing reaches the namespace if the cell throws before the end.

So the transform rewrites declarations into assignments: `let x = 1` becomes
`x = 1`, `function f() {}` becomes `f = function f() {}`. Each binding lands as
it executes. Functions keep their own name for recursion.

The cost is REPL semantics rather than module semantics: no temporal dead zone,
no const-ness across cells, and a redeclaration overwrites. That is the right
trade for a notebook, where incremental redefinition is the normal way to work.

### Cancellation is cooperative, and says so when it cannot be

Cancelling sends the guest an abort, stops forwarding the cell's output, and
resolves the caller after a short grace period. The cell's continuation may
still be scheduled — that cannot be undone — so instead its writes are refused:
the cell context carries an aborted flag the namespace proxy checks.

A cell spinning in synchronous code never yields, so nothing can interrupt it.
The engine does not pretend otherwise: the next call raises `EngineBusyError`,
and recovery is to kill the engine and start a fresh one, whose `restoreState`
brings the last snapshot back. Losing the process should not mean losing work.

### The protocol is separated and authenticated

Two properties, both load-bearing:

*Separation.* Protocol traffic uses a per-engine loopback TCP connection. The
guest's stdout and stderr carry only user output, so a cell printing JSON is just
a cell printing JSON. The host listens before spawning, authenticates the first
`ready` frame, then closes the listener; teardown awaits both process and socket.

*Authentication.* Every frame carries a nonce the host mints at spawn and the
guest erases from its environment before running any cell. Code inside a cell
cannot recover it.

Without both, a cell could announce its own completion — claiming success while
failing, or attributing output to another cell. An agent that cannot trust its
own results has nothing left to reason with.

### Snapshots are per-variable and best-effort

The namespace is serialised entry by entry, so one unserialisable value costs
only itself. Functions, live handles, and open resources do not survive; the
restore report names them. Engine-owned bindings are re-installed after a
restore, so a stale saved value cannot shadow a live handle.

### A subagent is a stack frame

Three unifications, each deleting a concept instead of adding one:

- **One identity.** pi's toolCallId is passed down as the engine's cell id and
  recorded as each child's `spawn_cell_id`, so a cell component finds its own
  children by filename match — no mapping tables.
- **One source of truth.** The frame record (`<child_id>.json` beside the
  output file) is the durable half of the registry; the in-memory map holds
  only process handles. Every process writes its children under its own
  `.pi-rlm/<session>/subagents/` in the shared cwd, so the full tree across
  all recursion depths is one directory walk — no IPC, and it works after
  every process has exited. A running record whose pid is gone reads as
  `lost` at display time; the file is never rewritten.
- **One renderer.** The spawning cell is frame #0: frames render beneath its
  output, visible even collapsed while anything runs (supervision should not
  require a keypress), folding into a header count chip once settled. A
  settled cell keeps itself live by asking pi for a repaint once a second
  while frames run; the chain stops on its own when they finish.

### The engine defers and caches, but never deletes

A long session accumulates state faster than it sheds it, and re-serialising
everything after every cell makes the session pay forever for what it did once.
Three rules keep the cost proportional to what is actually in use:

- A snapshot re-serialises only names touched since the last one; the rest are
  written from cached blobs. Reads count as touches, because interior mutation
  (`arr.push(1)`) is only visible as a read.
- On restore, values that are both large and long-untouched are not
  deserialized eagerly. Their blobs stay in the guest and load on first read —
  the proxy's get trap makes that a plain, if briefly slower, property access,
  announced in the cell's stderr. An unread value survives any number of
  snapshot/restore cycles intact.
- Removal is the agent's decision alone: `rlm.forget("name")` deletes a value
  from the namespace and all future snapshots. (Bare `delete x` is a strict-mode
  SyntaxError in cells, so the handle method is the deletion path.) The engine
  itself never drops agent state.

### Subagents return handles, not answers

`rlm.run` resolves at admission. A parent that blocked until its child finished
could not supervise it, and a handle is useful immediately while an answer is
not. Children write their final output to a file; the registry reports running,
completed, or errored, so the parent decides when to read.

### World is a live facade, not snapshot data

The guest installs an engine-owned `world` object beside the compatibility
`rlm` and `tools` bindings. Its methods are ordinary Promise APIs over the
same authenticated host bridge; Effect, Layers, process handles, and authority
state remain host-side. Installing this package is activation: `session_start`
always sets Pi's model-visible tools to exactly `["execute"]`.

`world.agents.spawn` returns an ergonomic live handle with `wait` and
`cancel`, and `spawnMany` admits every requested agent before callers await
results. There is deliberately no list/status API: completion is an event-backed
Promise rather than model-written polling. The host reconstructs the authority
subject from its own session, depth, and issuing-cell context, schema-decodes
requests before adapters run, and sends only stable safe error fields back.

One `SessionWorldOwner` creates the Authority, Agents, Web, and Shell Layers for
the Pi session, not for an execute cell or evaluator generation. A wedged evaluator
can be discarded and rebuilt while admitted World children continue; session
shutdown disposes the managed runtime, whose Agents Layer performs bounded
process-group cleanup and awaits child close. World child Pi commands use
`--no-extensions` and exactly one `-e` path to this fork, preventing an
installed copy from loading twice.

The live `world` binding is registered in the same internal-binding table as
`rlm` and `tools`. Snapshots skip it, namespace listing hides it, and
bootstrap overwrites any stale impostor restored under that name. Agent handles
contain closures and are intentionally reported as unserialisable; persist plain
AgentId or ShellExecutionId values only, without treating either ID as a live
handle.

The `world.shell` slice is intentionally a non-executing contract tracer.
Every admission walks the full governance path: the bridge strictly decodes the
schema-v1 script request and reconstructs the subject — including the
host-established principal — from its own session context, the grant layer
requires an active Shell Grant naming the served `virtual-tracer-v1` profile,
and a durable metadata-only admission audit is fsynced before any allocation.
An audit failure returns one stable unavailable error and creates no side
effect; a failed terminal audit marks the service unhealthy without rewriting
results, while lifecycle safety actions continue. Child agents may name a
narrower policy profile at spawn, and the host proves every component —
operations, root, network and environment rules, numeric ceilings, and the
drain exception — narrower than the caller's own grant before issuing the
immutable child grant. Revocation cascades to descendants, blocks admission,
attachment, and delegation, and cancels active work unless the served profile
permits bounded drain. The
public lifecycle is wait (with an optional observation timeout that withdraws
without cancelling), idempotent cancel, and exact-ID attach; every admitted
execution reaches exactly one closed v1 terminal branch (exited, timed_out,
cancelled, budget_exhausted, or failed) with bounded base64 stdout/stderr
captures. Retention erases output before metadata under session, time, and
payload caps — a result captured before erasure stays with its holder, while
later waits observe the erased record — and every refusal of wait, cancel, or
attach is one indistinguishable not-found, so unknown, foreign, and expired
IDs cannot be enumerated. There is deliberately no list, search, status, or retry surface.
This proves the capability path without pretending Host or Virtual commands
ran; real just-bash execution and the Virtual Environment remain separate
implementation slices.

Three boundaries are deliberate. Child-grant propagation stops at the host.
Attenuation is proven against the parent grant when spawn is admitted, but
carrying the derived principal and child grant into the child's own evaluator
needs a trusted transport slice, so a narrowed child today is constrained by
that admission-time proof rather than by authority it holds inside its own
process. The governed tracer owns its timers, records, and admission tracking,
but session shutdown finalizes only the Effect runtime. A dedicated shell
finalizer that cancels pending work belongs with the real Virtual Environment
adapter, whose lifetime rules it will share. Revocation keeps tombstone entries
in in-memory grant maps for the session's life. Unlike execution records they
have no cap, which is acceptable while sessions stay short-lived and worth
revisiting if they grow.

### World traces semantics, never payloads

World service calls create stable Effect spans for the coordinator, web search,
agent spawn, attempt, Pi process, wait, cancel, and Virtual Shell tracer operations. Attempt and
process observers are forked into the Agents Layer's explicit session scope, so
their parent span is inherited across the fiber boundary and their lifetime is
not cut short when admission returns. Shutdown settles processes before closing
that observer scope.

Tracing fields are an allowlist of scalar operation, depth, adapter, opaque
agent/attempt identity, bounded timeout, process identity, stable error code,
and outcome values. Task prompts, queries, credentials, command arguments,
stdout/stderr, web results, raw errors, events, and links are never recorded.
The deterministic in-memory tracer additionally replaces Effect's terminal
Exit with a coarse status, so a failure Cause cannot become an accidental test
export. Production can supply a normal Effect/OpenTelemetry tracer without
changing World services.

### Codex web stays behind one pinned executor seam

The experimental Web Layer imports only
`@howaboua/pi-codex-conversion/dist/tools/web-run/tool.js` at the package's
pinned 3.0.14 version. It delegates to `executeCodexWebSearch`, passing the
live Pi `ExtensionContext` and Effect's abort signal. The package continues to
own model selection, auth resolution, credential environment construction,
bundled binary lookup, native process execution, and result parsing.

This is deliberately a deep import, isolated in one module and protected by a
contract test. The adapter maps only `WebSearchRequest` and `WebResult`; it
does not register Codex's `web_run` ToolDefinition, copy provider code, or
handle credentials. If the pinned seam disappears and those internals must be
reimplemented, the spike stops rather than absorbing them.

### pi's tools are mounted behind the bridge, not registered with pi

The session runs with pi's builtin tools disabled; the model's only tool is
`execute`. But pi exports its tool implementations as plain ToolDefinitions,
so the host mounts them itself (`pi-tools.ts`): cells call
`await tools.read({ path })`, the request crosses the guest bridge, and the
definition executes host-side with the calling cell's abort signal. Arguments
are validated against each tool's own TypeBox schema before execution — a
failure names the problem and shows the expected signature, and an unknown
tool name suggests the nearest real one. The prompt's signature list is
generated from the same schemas, so documentation cannot drift from
validation.

The bridge instantiates the tool definitions itself rather than reusing the
ones pi registered for the session: pi's extension API exposes active tool
*names* (`getActiveTools`), not definitions, so there is no clean handle to
the registered objects — and in the activated configuration the builtins are
deactivated anyway. Instantiating from the same factories pi uses keeps the
behaviour identical at the cost of a second (idle) set of definition objects.

Two consequences of the bridge being JSON: tool details cross as data, and
image blocks cannot cross as pixels the model would see. Images are therefore
held host-side and forwarded into the cell's tool-result content; the guest
value reports `images: n`. Costs: a bridged tool runs host-side, so its
filesystem view is the host's (same machine, same cwd — a difference only if
the guest ever runs elsewhere), and its output is data returned to the cell
rather than transcript output.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Cell throws | `status: "error"` with name, message, and stack; namespace intact |
| Cell cancelled | `status: "aborted"`; continuation cannot write or stream |
| Synchronous infinite loop | Abort settles; next call raises `EngineBusyError`; recover by restarting and restoring |
| Stray async throw | Reported as cell stderr; the evaluator stays alive |
| Guest process dies | Pending calls settle, engine reports itself down, later calls reject |
| Host exits | Guest is killed; if the host dies abruptly, the guest self-exits on stdin EOF |
| Output flood | Capped per channel with the truncation announced |

## Testing

`test/engine.contract.test.ts` is the specification: behavioural tests against a
real engine and a real guest, each stating a guarantee and its rationale.

`test/units.test.ts` covers what behaviour alone cannot reach — the transform
(which runs in the guest process), protocol framing, prompt assembly, and cell
layout, including the width invariant that keeps a row's metadata legible at any
terminal size.

`test/subagents.test.ts` covers legacy delegation with an injected spawn command.

`test/session-world.test.ts` covers always-on extension activation, one World
scope across evaluator generations, exact child extension loading, and awaited
session-shutdown process cleanup.

The "Shell principals, grants, and mandatory audit" suite in
`test/world-core.test.ts` owns the governance invariants of the World Shell:
least-authority admission, component-wise attenuation denials, session-bound
grants, frozen profiles, ceiling and concurrency enforcement, owner/ancestor
supervision with indistinguishable refusals, revocation cascades, audit-outage
containment, and the metadata-only privacy guarantee.

`test/world-tracing.test.ts` proves privacy-safe span parentage across the
session-owned process fiber. `test/evaluator-comparison.test.ts` extracts the
committed `70d45e6` pi-rlm engine archive and runs the same normalized script
through that engine and this fork; durations, paths, and stack locations are the
only normalized data.

The opt-in Linux certification with three genuine Pi children and the hidden
Codex native web path is recorded in
`docs/certification/world-spike-2026-08-13.md`; raw model sessions are deliberately
not committed. `bun run check` is the deterministic gate: typecheck, lint, and
the full suite.
