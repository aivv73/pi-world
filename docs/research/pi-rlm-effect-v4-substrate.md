# Should pi-rlm become Effect v4-native?

> Research note, 2026-08-13. This evaluates a possible programmable Agent World substrate; it does not change the current `@aivv/pi-subagents` architecture and is not a rewrite plan.
>
> The implementation target is the separately named `@aivv/pi-world` fork. The `pi-rlm` name remains here where it identifies the evaluator behavior and source provenance; `.pi-rlm` storage and `PI_RLM_*` environment names remain compatibility surfaces during the spike.

## Decision in one page

**Yes, with an important qualification.** Effect v4 is a materially cleaner substrate for capability implementations, child-process ownership, cancellation, typed failure, and tracing. It does **not** replace pi-rlm's evaluator, create durable agents, or make other Pi extensions callable by magic.

The best next move is **strategy B: a narrow fork that preserves the evaluator and replaces only host orchestration behind its existing bridge**. The fork should be allowed to converge toward a new extension later, but the first proof should retain pi-rlm's observable evaluator behavior and tests.

The decisive source findings are:

1. pi-rlm already has a strong evaluator boundary: Pi's `execute` tool calls a host `EngineManager`, which talks to a persistent Bun guest; guest code invokes host operations through a generic `requestType -> handler` bridge. Reuse this boundary.
2. The child-agent implementation is not similarly deep. It is a `child_process` map plus JSON frame files. The model waits by repeatedly calling `rlm.listSubagents()` and sleeping. Cancellation sends a signal without awaiting termination or escalating. The in-memory registry is empty after host restart even though frame files remain.
3. Effect v4 directly represents the missing in-process lifecycle: `forkChild`/`forkIn`, `Fiber.join`, interruption, `Scope`, `timeout`, `Schedule`, typed errors, and spans. The actual v4 RC service API is `Context.Service`, not the old `Context.Tag` spelling.
4. Capability composition inside one extension is straightforward with services and independently merged Layers. Composition with **arbitrary already-loaded Pi tools is not currently available**: Pi 0.84.1 exposes `getAllTools()` metadata but not the executable definitions or an invocation method to extensions.
5. Codex conversion's web search is a normal Pi `ToolDefinition`. Its implementation is factored as `executeCodexWebSearch`, but that function is not a declared top-level public API; it needs Pi's current `ExtensionContext` to resolve model/auth/session information and then runs a bundled Rust `web_run` process.
6. `just-bash` is a good candidate for a constrained, virtual shell/environment service, not an automatic replacement for Pi's host shell. It has an in-memory filesystem, explicit command/network enablement, execution budgets, and cooperative `AbortSignal` support. Its own source warns that defense-in-depth is secondary, and custom commands are trusted by default.

Therefore Effect answers the lifecycle and internal-composition questions positively, while the Pi ecosystem interop question requires one additional seam:

```text
Pi extension registry
  ├─ current: list metadata, choose model-visible names
  └─ needed: invoke a configured tool without making it model-visible
                          │
                          ▼
                 PiToolCapabilityAdapter
                          │
             Effect service + authority check
                          │
                    world.web.search
```

Do not block the spike on that upstream seam. For the spike, use one explicit Codex web adapter and record the friction. If the adapter requires copying Codex internals, stop: that is evidence against proceeding until a supported provider API or Pi invocation API exists.

## Sources inspected

All claims below were checked against source at these revisions, not only READMEs:

| Project | Revision/version | Principal source paths |
|---|---|---|
| Pi | [`46bb9a2`](https://github.com/earendil-works/pi/tree/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106), coding-agent/agent-core 0.84.1 | [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/agent/src/agent-loop.ts), [`agent-session.ts`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/coding-agent/src/core/agent-session.ts), [`extensions/loader.ts`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/coding-agent/src/core/extensions/loader.ts), [`extensions/runner.ts`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/coding-agent/src/core/extensions/runner.ts), [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/46bb9a2c3bdb296b0d2179f7309ec6b79a7f3106/packages/coding-agent/src/core/extensions/types.ts) |
| pi-rlm | [`70d45e6`](https://github.com/shift-labs-ai/pi-rlm/tree/70d45e65dbb25ee3f434a2f559fa10ff397a8148), 0.4.0 | [`engine/index.ts`](https://github.com/shift-labs-ai/pi-rlm/blob/70d45e65dbb25ee3f434a2f559fa10ff397a8148/src/engine/index.ts), [`engine/guest.ts`](https://github.com/shift-labs-ai/pi-rlm/blob/70d45e65dbb25ee3f434a2f559fa10ff397a8148/src/engine/guest.ts), [`engine/transform.ts`](https://github.com/shift-labs-ai/pi-rlm/blob/70d45e65dbb25ee3f434a2f559fa10ff397a8148/src/engine/transform.ts), [`extension/index.ts`](https://github.com/shift-labs-ai/pi-rlm/blob/70d45e65dbb25ee3f434a2f559fa10ff397a8148/src/extension/index.ts), [`subagents.ts`](https://github.com/shift-labs-ai/pi-rlm/blob/70d45e65dbb25ee3f434a2f559fa10ff397a8148/src/extension/subagents.ts), [`pi-tools.ts`](https://github.com/shift-labs-ai/pi-rlm/blob/70d45e65dbb25ee3f434a2f559fa10ff397a8148/src/extension/pi-tools.ts) |
| pi-peer | [`5e8fcb2`](https://github.com/shift-labs-ai/pi-peer/tree/5e8fcb20c14cc5bc99a704e5b466f22bcf553861), 0.2.0 | [`transport.ts`](https://github.com/shift-labs-ai/pi-peer/blob/5e8fcb20c14cc5bc99a704e5b466f22bcf553861/src/peer/transport.ts), [`registry.ts`](https://github.com/shift-labs-ai/pi-peer/blob/5e8fcb20c14cc5bc99a704e5b466f22bcf553861/src/peer/registry.ts), [`mailbox.ts`](https://github.com/shift-labs-ai/pi-peer/blob/5e8fcb20c14cc5bc99a704e5b466f22bcf553861/src/peer/mailbox.ts), [`extension/index.ts`](https://github.com/shift-labs-ai/pi-peer/blob/5e8fcb20c14cc5bc99a704e5b466f22bcf553861/src/extension/index.ts) |
| pi-codex-conversion | [`d2e9b82`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d2e9b82f8abafa24f8488d5211f8307ea4815edb/packages/pi-codex-conversion), 3.0.14 | [`extension/tools.ts`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e9b82f8abafa24f8488d5211f8307ea4815edb/packages/pi-codex-conversion/src/extension/tools.ts), [`web-run/tool.ts`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e9b82f8abafa24f8488d5211f8307ea4815edb/packages/pi-codex-conversion/src/tools/web-run/tool.ts), [`codex-tool-provider.ts`](https://github.com/IgorWarzocha/howaboua-pi-stuff/blob/d2e9b82f8abafa24f8488d5211f8307ea4815edb/packages/pi-codex-conversion/src/adapter/codex-tool-provider.ts) |
| Effect v4 RC | [`12133ea`](https://github.com/Effect-TS/effect/tree/12133eae042297cfbb03c0ef4b85614b0af51364), 4.0.0-rc.108 | [`Context.ts`](https://github.com/Effect-TS/effect/blob/12133eae042297cfbb03c0ef4b85614b0af51364/packages/effect/src/Context.ts), [`Effect.ts`](https://github.com/Effect-TS/effect/blob/12133eae042297cfbb03c0ef4b85614b0af51364/packages/effect/src/Effect.ts), [`Fiber.ts`](https://github.com/Effect-TS/effect/blob/12133eae042297cfbb03c0ef4b85614b0af51364/packages/effect/src/Fiber.ts), [`Scope.ts`](https://github.com/Effect-TS/effect/blob/12133eae042297cfbb03c0ef4b85614b0af51364/packages/effect/src/Scope.ts), [`Layer.ts`](https://github.com/Effect-TS/effect/blob/12133eae042297cfbb03c0ef4b85614b0af51364/packages/effect/src/Layer.ts), [`ManagedRuntime.ts`](https://github.com/Effect-TS/effect/blob/12133eae042297cfbb03c0ef4b85614b0af51364/packages/effect/src/ManagedRuntime.ts), [`Tracer.ts`](https://github.com/Effect-TS/effect/blob/12133eae042297cfbb03c0ef4b85614b0af51364/packages/effect/src/Tracer.ts), [`TxRef.ts`](https://github.com/Effect-TS/effect/blob/12133eae042297cfbb03c0ef4b85614b0af51364/packages/effect/src/TxRef.ts) |
| just-bash | [`1fbde34`](https://github.com/vercel-labs/just-bash/tree/1fbde341d74ff7f933d9cead9a390a6ab65b5df3), 3.2.0 | [`Bash.ts`](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/Bash.ts), [`execution-scope.ts`](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/execution-scope.ts), [`custom-commands.ts`](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/custom-commands.ts) |

## Current control flow

### Pi turn and tool execution

Pi's `AgentSession.prompt()` processes extension input hooks and prompt expansion, invokes `before_agent_start`, applies any system-prompt override, and calls `agent.prompt()`. The agent loop streams an assistant response, extracts tool calls, validates each call against its tool schema, runs the `beforeToolCall` hook, invokes `tool.execute(...)`, runs `afterToolCall`, appends tool-result messages, and starts another model turn while tool calls or queued steering messages remain. Pi persists user, assistant, and tool-result messages on `message_end`; `agent_settled` occurs after retries, compaction continuations, and queued follow-ups are exhausted.

Tool calls are parallel unless the loop or any selected tool requests sequential execution. pi-rlm's evaluator nevertheless serializes `execute` calls itself because it has one shared namespace.

```text
AgentSession.prompt
  -> before_agent_start extensions
  -> agent.prompt / runLoop
  -> provider stream
  -> assistant toolCall("execute")
  -> TypeBox validation + tool_call hooks
  -> pi-rlm execute ToolDefinition
  -> tool_result hooks
  -> persisted ToolResultMessage
  -> next model turn
```

### pi-rlm execute and evaluator

The extension activates by replacing Pi's active model-visible tools with `execute`. `EngineLifecycle.acquire()` creates and restores an `EngineManager` if needed. `EngineManager.execute()` synchronously claims a Promise-chain queue slot, starts a persistent Bun child, sends a nonce-authenticated `run` frame over stdin, and receives protocol/result frames on fd 3. User stdout/stderr use separate pipes.

The guest:

1. strips TypeScript with `Bun.Transpiler`;
2. parses with Acorn;
3. rewrites top-level variables/functions/classes into assignments;
4. rewrites static imports to awaited dynamic imports (with a special `npm:` cache path);
5. captures a trailing expression;
6. executes an async function inside `with (namespaceProxy)`.

The proxy resolves namespace values before globals and records reads/writes for snapshot caching. `AsyncLocalStorage` attributes output and host requests to the originating cell. A successful execute schedules a debounced snapshot.

This process boundary is valuable: a crashing or synchronously wedged evaluator does not take Pi down. Effect should wrap it, not erase it.

### Capability invocation today

Guest bootstrap installs two hard-coded handles:

- `rlm`: `run`, `listSubagents`, `deleteSubagent`, and generic `hostRequest`;
- `tools`: seven fixed Pi builtins.

A guest host request becomes an `EngineManager.dispatchHostRequest()` lookup in a `Record<string, HostRequestHandler>`. The handler receives the cell ID and that cell's `AbortSignal`. This dictionary is already the right evaluator-to-world seam.

The accidental coupling is above and below it:

- `extension/index.ts` constructs `SubagentHost` and `PiToolsHost` directly;
- `guest.ts` hard-codes method names and the seven-tool list;
- `pi-tools.ts` reconstructs Pi builtin definitions from factories because pi-rlm was not given callable registered definitions.

Pi 0.84.1 now provides `pi.getAllTools()`, but `ToolInfo` contains only name, description, schema, guidelines, and source metadata. `ExtensionRunner.getToolDefinition()` exists internally; it is not exposed by `ExtensionAPI`. Thus a hidden `web_run` can be discovered but not called through Pi.

### pi-rlm child spawn and completion

`rlm.run` crosses the bridge to `createSubagentHost()`:

1. generate `sub-<uuid>` and output/frame paths;
2. write a JSON frame with `status: running`;
3. spawn `pi -p --no-extensions -e <pi-rlm extension> ... <prompt>`;
4. redirect stdout and stderr to the output file;
5. return the plain-data handle immediately;
6. update in-memory entry and frame JSON from child `exit`/`error` listeners.

There is no awaitable child completion primitive in the model API. The prompt explicitly tells the model to call `rlm.listSubagents()`, inspect `status`, sleep, and repeat. `deleteSubagent` sends `SIGTERM` and removes the registry/frame immediately; it does not await exit or escalate. Session engine disposal sends `SIGKILL` to all children.

The JSON frame files preserve display lineage, not a resumable execution registry. On a new `SubagentHost`, the in-memory `registry` and `children` maps start empty. Frame rendering can discover old files and derive `lost` from a dead PID, but `rlm.listSubagents()` cannot recover those handles after engine restart. A parent crash also prevents its exit listener from finalizing a child frame.

### Persistence and resume

The evaluator snapshot is per variable and uses Bun/JSC `serialize` blobs encoded as base64. It preserves tested plain data and lets one unserializable value fail without poisoning the others. Large cold blobs may stay serialized until first read. Snapshot metadata tracks last-touch cell sequence so unchanged values can reuse cached blobs.

What does and does not survive:

| Value/mechanism | Same guest | Fresh guest/session resume |
|---|---:|---:|
| Plain objects, arrays, numbers, strings | yes | tested yes |
| Top-level functions/classes | yes | no; function-like/live values fail serialization |
| Static imports/module exports | yes | only if the resulting bound value is JSC-serializable; functions normally are not |
| `rlm`, `tools`, future `world` live handles | reinstalled engine bindings | must be reinstalled, never treated as snapshot data |
| Child handle's plain fields | can be saved as data | fields may revive, but the new host registry cannot operate on the old execution |
| Child process/fiber | process map only | no |

Resume is keyed to Pi's session filename. `session_start` records the session location and calls `restoreState`; acquire-on-first-cell repeats this safety for reload paths where startup may not fire. A reset notice tells the model the namespace may be behind.

Two limits matter before calling this durable state:

- `writeFileSync` replaces the snapshot directly rather than using temp-file + rename, and restore collapses parse/read failures to `null`.
- serialization failures are included in the snapshot request result, but debounced automatic snapshots ignore that result; the next restore cannot report values that were never written. The current “honest” behavior is therefore strongest for explicit snapshot calls, not fully surfaced on ordinary resume.

Effect STM does not change any of this. In v4, `Effect.tx` plus `TxRef`/`TxQueue` provides in-process atomic coordination. It neither persists JSC blobs nor reconciles processes after a crash.

### pi-peer and just-bash

pi-peer already has a useful adapter boundary: `Transport` covers register/heartbeat/offline, survey, deposit/receipt, watch, sweep, and close. `LocalTransport` implements it with atomically renamed files and `fs.watch` plus polling; the Redis adapter preserves queued delivery with lists and acknowledgements. Session identity derives from cwd plus Pi session ID and therefore survives process restart. This is a **peer transport**, not child-agent execution. An Effect `PeerTransport` Layer can wrap this contract nearly unchanged.

just-bash's public `Bash.exec(script, { signal })` creates an `ExecutionScope` with time, command, work, input/output, memory, depth, and cleanup budgets. Each public exec gets isolated shell state while sharing the Bash instance's virtual filesystem and base state. Abort is cooperative at interpreter/command boundaries and returns exit 124 for an `ExecutionAbortedError`. Network and Python/JavaScript are opt-in; commands can be allowlisted; the default filesystem is virtual/in-memory.

That makes it suitable for a future `EnvironmentShell` or sandboxed data-processing capability. It does not execute arbitrary host programs or automatically see the project filesystem, so naming it simply `Shell -> JustBash` would silently change the semantics users expect from Pi/Bun shell access.

## Prototype semantics worth preserving

These are source-verified behavior, not implementation loyalty:

- one low-schema `execute` surface;
- a persistent programmable TypeScript namespace across tool calls and turns;
- top-level await, incremental binding, imports, functions, classes, and trailing-expression results within a live guest;
- programmatic host calls whose values can be stored, transformed, fanned out, and reduced;
- child admission returning a handle rather than blocking for an answer;
- recursive Pi children with explicit depth bounds;
- process separation between Pi and arbitrary evaluator code;
- automatic best-effort namespace snapshot/resume with visible reset/loss reporting;
- cell identity propagated into host calls and child lineage;
- strict attribution of output and cancellation signals to the originating cell;
- keeping host capabilities behind one model-visible schema.

## Implementation details not worth preserving by default

- model-written status polling and sleep loops;
- the Promise-chain execution queue as the universal orchestration mechanism;
- per-capability construction in the extension composition root;
- the hard-coded guest `TOOL_NAMES` list;
- reconstructing Pi builtins in pi-rlm instead of invoking configured capabilities through an owner-supported seam;
- in-memory child registries as execution authority;
- conflating a random child ID, process, Pi conversation, and one execution attempt;
- `SIGTERM` without awaited settlement/escalation on explicit cancellation;
- using frame JSON both as UI input and the closest thing to persistence;
- output-file existence as the result protocol;
- snapshot format and direct-write choices as permanent public contracts;
- assuming host and guest always have identical filesystem/environment authority;
- killing all children as a side effect of evaluator replacement rather than explicit session/run ownership.

The evaluator's nonce-separated protocol, per-cell attribution, transform, proxy namespace, and snapshot caching are not in this list: they solve concrete hard problems and should remain until separately disproven.

## Mapping onto Effect v4

| pi-rlm/world concept | Effect v4 mapping | Assessment |
|---|---|---|
| One world operation | `Effect<A, E, R>` | Natural. `R` states implementation requirements; it is not caller authority. |
| Service contract | `Context.Service` | Natural. In rc.108 this is the actual API; avoid v3 `Context.Tag` examples. |
| Implementation/configuration | `Layer` | Natural. `Layer.mergeAll` composes independent Web/Agents/Shell adapters and owns scoped acquisition. |
| One child execution | `Fiber<AgentResult, AgentError>` waiting on a Pi SDK session or process | Natural for one **attempt**, not for durable Agent identity. |
| Child completion | `Fiber.join`; `Fiber.await` when outcome must be data | Natural; removes status polling. A `Deferred` is useful when callbacks/process events complete a separately held handle. |
| Attached children | `forkChild` or `forkIn` an explicit scope | Natural, but choose the scope carefully. An execute-cell Promise is too short-lived. |
| Detached children | `forkDetach` | Mechanically available, semantically unsafe without durable ownership. Do not expose in the spike. |
| Cancellation | fiber interruption + adapter finalizer/AbortSignal | Natural. `Effect.tryPromise` supplies an AbortSignal; process adapters still must implement TERM/grace/KILL. |
| Timeout | `Effect.timeout` | Natural and typed; timeout interrupts the source effect. Distinguish “stop waiting” from “cancel execution.” |
| Retry | `Effect.retry` + `Schedule` | Natural only after errors are classified transient/permanent and spawn idempotency is defined. Do not retry all child failures. |
| Child group | explicit `Scope`, or higher-level `Effect.all` for fixed fan-out | Natural. Scope is lifetime ownership; it is not itself a durable group record. |
| One-consumer event stream | `Queue` | Natural for progress/events consumed once. |
| Broadcast event stream | `PubSub` | Natural for UI + telemetry subscribers. Do not introduce either until there are multiple events or consumers. |
| External payloads/checkpoints | `Schema` decode/encode | Natural at process, file, and Pi boundaries. Do not schema-wrap internal values gratuitously. |
| Lifecycle failures | tagged errors in Effect's typed error channel | Natural. Defects and interruption remain distinct causes; they should not be flattened into “error.” |
| Instrumentation | `Effect.withSpan`, `Effect.fn("name")`, annotations, metrics | Natural. The OpenTelemetry package already provides scoped tracer/metric layers. |
| Shared in-process admission state | `Ref`, `Semaphore`, optionally `Effect.tx` + `TxRef` | Natural when contention warrants it. Not persistence. |
| Durable Agent/session state | persistence port + schemas + reconciliation | No direct Effect primitive. Separate domain work. |

### The Promise/object boundary

The model should not see Effect. A session-owned `ManagedRuntime` builds Layers once and is disposed on `session_shutdown`. The guest receives one engine-owned `world` object. Its methods make bridge requests; host handlers run Effects through the managed runtime and return JSON-safe data.

```text
model code
  await world.web.search(query)
  await worker.wait()
        │ Promise/object API
        ▼
bridge request + Schema decode + authority check
        │
        ▼
ManagedRuntime.runPromise(Effect service operation)
        │
        ▼
Web / Agents service implementation Layer
```

A subtle lifecycle rule: do not `forkChild` from the short `runPromise` that services one bridge request and expect the fiber to survive after admission. Either fork the agent into a session-owned explicit `Scope`, or have the Agents Layer own such a scope as a scoped resource. Dispose that scope when the Pi session shuts down.

Promise rejection should contain a small stable world error (`code`, safe message, optional operation/agent ID), not Effect's internal `FiberFailure` rendering. Internally retain the full Cause for logs/spans.

## Capability composition design

### Contracts

Start only with contracts needed by the spike:

```text
Web
  search(request) -> Effect<WebResult, WebError>

Agents
  spawn(request)  -> Effect<AgentHandleData, SpawnError>
  wait(agentId)   -> Effect<AgentResult, AgentFailure>
  cancel(agentId) -> Effect<void, AgentNotFound | CancelFailure>

Authority
  check(subject, operation, resource) -> Effect<void, Denied>
```

`PeerTransport`, `Shell`, `Memory`, and `Persistence` are later contracts. `Authority` is separate because having `Web` in the Effect environment only means the implementation was injected. It does not mean a model, child, or workspace is allowed to use it.

The composition root chooses implementations:

```text
AuthorityLive
Agents -> PiProcessAgents        # spike; PiSdkAgents remains an adapter option
Web    -> CodexConversionWeb     # spike-only supported seam required

Layer.mergeAll(AuthorityLive, PiProcessAgents, CodexConversionWeb)
```

Each public operation performs an authority check at the service boundary. Layers decide *how* an operation runs; authority decides *whether this subject may request it*. Do not encode grants by conditionally omitting services alone: that confuses wiring failures with denials and is too coarse for resource-specific rules.

### Participating in Pi extension discovery

Pi already discovers packages/extensions and consolidates registered tools. Keep that mechanism. The missing feature is a non-model-facing invocation seam.

A useful Pi API would be conceptually:

```ts
pi.invokeTool(name, args, { signal, onUpdate })
```

It should invoke the same configured wrapped definition Pi would invoke for the model, including argument preparation/validation, `ExtensionContext`, tool-call/tool-result hooks, image normalization, and usage/details. It should not require the tool to be in `agent.state.tools`. The API must reject recursion into `execute`, respect Pi's allow/exclude configuration, and leave World authority checks to the caller.

`getAllTools()` can support discovery and diagnostics, but metadata alone must not be treated as invocation authority. The World adapter should expose only explicitly mapped/allowed operations, for example `web_run -> Web.search`, not automatically turn every installed tool into `world.<name>`.

Until such an API exists, there are three less satisfactory choices:

1. import an implementation's supported library API directly;
2. ask an extension to publish a cooperative World provider API;
3. recreate or copy its implementation.

Use (1) for the spike only if supported. pi-codex-conversion currently exports only its default extension plus activation helpers at the package root. Its wildcard package export makes internal files technically importable, but that is not a stable provider contract. `executeCodexWebSearch` also requires live Pi context for model registry/auth/session ID. This is precisely the adapter friction the spike should measure. Do not choose (3).

### Codex web path

Actual flow:

```text
web_run ToolDefinition.execute
  -> supportsExecutableWebSearch(current model/config)
  -> executeCodexWebSearch(params, ExtensionContext, signal)
  -> resolveCodexToolProvider
  -> modelRegistry.getApiKeyAndHeaders
  -> env with token/account/base/search URLs
  -> bundled Rust web_run process
  -> parse JSON and return text + encrypted/details payload
```

A `CodexConversionWeb` Layer should adapt this capability, not teach the evaluator about Codex. Keep credentials inside the adapter/process environment; do not return them through the bridge or snapshot them.

## Persistent evaluator strategy

### Reuse unchanged first

Reuse or extract these exact pieces with their contract tests:

- `src/engine/index.ts` — process/protocol, serial execution, output attribution, abort mapping, snapshot API;
- `src/engine/guest.ts` — namespace/proxy, AsyncLocalStorage attribution, host bridge, snapshot implementation;
- `src/engine/transform.ts` — TypeScript/import/declaration/result transformation;
- `src/engine/protocol.ts` — authenticated framing;
- `src/engine/npm.ts` — isolated lazy `npm:` loading;
- `test/engine.contract.test.ts` — behavioral evaluator specification;
- `src/extension/session-engine.ts` — restore-on-acquire and reset notices, unless absorbed with no semantic change.

Required small change: replace hard-coded `rlm`/`tools` capability methods with an engine-owned `world` facade (or add `world` beside them during comparison). Keep generic `hostRequest` underneath. Do not put Layers, services, Fibers, or schemas into guest-authored model code.

Do not persist executable handles. Persist plain Agent IDs and data, then rehydrate behavior from the live `world` binding. A revived `const worker = ...` cannot remain a working class/function handle through JSC serialization. The durable form is `agentId`; after resume, future code would call `world.agents.get(agentId)`. Full handle rehydration is not part of the spike.

### Evaluator questions deferred, not ignored

A later hardening task may address atomic snapshot replacement, explicit format/version migration, surfaced serialization-loss manifests, and checkpoint boundaries. These are independent of Effect adoption. Rewriting the evaluator now would confound the experiment: a failure could come from Effect architecture or from changed REPL semantics.

## Child-agent lifecycle model

### Identities

Use three distinct identifiers:

- `AgentId`: domain identity, stable if/when persisted;
- `AttemptId`: one execution of that agent;
- `Fiber.id`/PID/Pi session ID: ephemeral runtime identities recorded as observations, never domain keys.

For the spike, `AgentId` and `AttemptId` live only for the Pi extension session. Do not claim durable agents yet.

### Ownership and outcomes

Because `spawn()` returns at admission and handles may be used in later cells/turns, children cannot be attached to the execute cell's lifetime. The spike should use one Agents Layer scope owned by the Pi session:

```text
Pi session scope
  └─ Agents adapter scope
      ├─ attempt A fiber -> Pi child process
      ├─ attempt B fiber -> Pi child process
      └─ attempt C fiber -> Pi child process
```

Recommended semantics:

| Event | Spike behavior | Durable future behavior |
|---|---|---|
| Execute cell finishes | children continue | same |
| Parent model turn settles | children continue until awaited/cancelled/session shutdown | policy may add explicit groups; do not infer from settlement |
| Pi session shuts down/reloads/switches | close scope; interrupt attached fibers; adapter TERM/grace/KILL and awaits exit | persist interruption intent/outcome before/after side effect |
| Parent is interrupted while spawning | admission effect interrupted; if process acquired, finalizer terminates it | persist ambiguous admission for reconciliation |
| `worker.wait()` | `Fiber.join`/Deferred-backed wait, no polling | rehydrate by AgentId and observe durable terminal state |
| Wait timeout | fail the wait with `WaitTimeout`; child keeps running unless API explicitly requests cancel | same distinction |
| Execution timeout | interrupt attempt, terminate process, terminal timed-out result | journal intent/outcome |
| `worker.cancel()` | interrupt and await cleanup; idempotent | durable cancel request and reconciliation |
| Child exits nonzero | typed `AgentProcessFailed` with exit/signal and bounded output reference | durable terminal attempt failure |
| Retry | not automatic in spike | new AttemptId under same AgentId, only for classified retryable failures |
| Host process crashes | fibers/finalizers vanish; OS child may be orphaned; spike reports unsupported | startup reconciliation inspects durable attempt + external Pi/process identity |
| Pi session resumes | evaluator plain data may revive; child handles do not | reconstruct handles from persistence; resume/reconcile attempts separately |
| Detached request | reject/not exposed | requires runtime-root ownership, persistence, quotas, and explicit cancellation UI |

“Parent finishes” is intentionally split into cell completion, model-run settlement, and session shutdown. Conflating them either kills useful admitted children immediately or leaks them indefinitely.

A process is not made interruptible merely by putting its wait in a fiber. The adapter must connect interruption to `AbortSignal`/process signals, register a finalizer, wait a bounded grace interval, escalate, and wait for close. Effect makes ownership explicit; it cannot force an uncooperative OS process to comply.

## Observability

Wrap service operations, not evaluator implementation trivia:

```text
world.execute / coordinator
  ├─ web.search
  ├─ agent.spawn
  │   └─ agent.attempt
  │       └─ pi.process
  ├─ agent.spawn
  │   └─ agent.attempt
  └─ agent.wait
```

Use `Effect.withSpan` or named `Effect.fn` operations and annotate with safe fields such as `agent.id`, `attempt.id`, adapter, model, outcome, duration, token/cost when supplied, and cancellation reason. Never attach prompts, credentials, arbitrary web content, or full shell output by default.

Effect's tracer maintains parentage across fibers, and `@effect/opentelemetry` supplies tracer/metric Layers. That is enough to test whether the desired execution graph appears. Exporting to a console/in-memory test tracer is sufficient for the spike. Do not build a trace store or dashboard.

One caveat: external Pi child internals will not automatically become nested spans. The parent can span process lifetime; cross-process propagation requires an explicit trace context protocol later.

## Strategy comparison

Rough estimates assume one engineer familiar with TypeScript, Pi, and Effect, and include focused tests but not production-grade durable recovery.

| | A. Patch pi-rlm | B. Fork, replace host internals progressively | C. New Effect-native extension |
|---|---|---|---|
| First useful spike | 3–6 engineering days | 5–10 days | 10–20 days |
| Reusable code | highest; evaluator and extension remain | high; evaluator/tests/rendering reused, orchestration replaced | medium; evaluator can be copied/extracted, most wiring new |
| Compatibility risk | lowest short-term | low-to-medium; preserve evaluator tests and dual-run comparisons | highest; easy to drift on prompt, rendering, resume, and REPL edge cases |
| Architectural cleanliness | low-to-medium; old registries/polling likely survive behind adapters | high if bridge and domain identities are explicit | potentially highest, but only after recreating mature evaluator/session behavior |
| Capability composition | can add a generic handler registry, but tends toward special cases | clean service/Layer composition; still needs Pi/provider invocation seam | same internal cleanliness; same external Pi seam problem |
| Lifecycle improvement | incremental and mixed Promise/Effect ownership | strong; replace child host as one bounded unit | strong, but requires rebuilding all surrounding lifecycle |
| Migration path | easiest release, hardest mechanism deletion | best: evaluator parity first, then delete mechanisms one at a time | flag/package switch; larger cutover |
| Comparative evals | trivial old vs patched versions | strong: preserve execute behavior and run old/new child backends side by side | possible but more confounded variables |
| Main failure mode | Effect becomes another adapter layer without deleting polling/maps | fork drifts or keeps two orchestration systems too long | rewrite spends effort rediscovering evaluator invariants |

### Recommendation

Choose **B**, with two guardrails:

1. Treat `engine/*` plus evaluator contract tests as imported specification. Do not Effect-ify code just to change syntax.
2. Replace a whole mechanism at a time. The first replacement is `createSubagentHost`: after Effect Agents works, remove polling-oriented APIs from the new world path rather than wrapping the old registry.

Strategy A is a reasonable fallback if the spike cannot compose Codex web without invasive coupling or if the Effect process adapter is not simpler than `subagents.ts`. Strategy C should be reconsidered only after the evaluator is extracted behind a supported package boundary or the fork has already isolated it cleanly.

## Smallest independent spike

### Question answered

Can one Pi extension keep pi-rlm's evaluator semantics while Effect owns a session-scoped group of Pi children and an independently composed Codex web capability, with no status polling and only `execute` visible to the model?

### Scope

1. Fork/copy the existing evaluator and its contract tests unchanged.
2. Build a session-owned `ManagedRuntime` from three Layers: `Authority`, `Agents`, and `Web`.
3. Add an engine-owned `world` facade with:
   - `world.agents.spawn(task)`;
   - `world.agents.spawnMany(tasks)`;
   - returned `{ id, wait(), cancel() }` ergonomic handles;
   - `world.web.search(query)`.
4. Implement `PiProcessAgents` using Effect scope/fibers around the same Pi CLI child behavior as pi-rlm.
5. Start three children before awaiting any, then `Promise.all(handles.map(h => h.wait()))`.
6. Prove explicit cancellation, execution timeout, nonzero exit, and session-shutdown cleanup without registry polling.
7. Implement `CodexConversionWeb` only through an import/API that does not copy credentials, provider routing, or Rust process logic.
8. Keep Pi's model-visible active tools at `['execute']`.
9. Add spans and use an in-memory tracer assertion for the expected parent/child graph.
10. Run the same evaluator persistence tests and a scripted behavioral comparison against pi-rlm 0.4.0.

### Acceptance evidence

- all three child start events occur before the first child completion;
- `wait()` settles from child completion events, with zero calls to a status/list API;
- cancelling one child does not cancel siblings and awaits process cleanup;
- closing the parent session leaves no attached child process;
- a wait timeout does not silently kill the child, while an execution timeout does;
- child failure is distinguishable from cancellation and timeout;
- Codex web search executes through its own adapter while `web_run` remains absent from the model tool schema;
- plain evaluator state survives another execute call and a restart snapshot test;
- functions/live handles are explicitly reported/treated as non-durable;
- trace parentage includes coordinator, web search, spawn/attempt, and wait spans;
- the new orchestration module has less lifecycle bookkeeping than pi-rlm's `subagents.ts`, not merely different bookkeeping.

### Stop conditions

Stop and report evidence against continuing if:

- Codex integration requires copying its auth/provider/native-process internals;
- the Agents adapter needs both an Effect registry and a second Promise/process authority map;
- admitted child fibers accidentally die when the bridge request returns;
- preserving evaluator behavior requires a guest rewrite;
- the only way to call surrounding Pi capabilities is to reactivate their model-visible schemas;
- cancellation cannot be made bounded and observable with less code than the current implementation.

## Explicitly not building yet

- the complete `world.*` namespace or a generic capability marketplace;
- durable Agent identity, crash recovery, execution reconciliation, or detached agents;
- distributed scheduling, clustering, leases, or remote fibers;
- a persistence/event-sourcing system for World;
- an STM-based imitation of durable persistence;
- evaluator replacement, sandbox redesign, or a new snapshot format;
- automatic wrapping of every Pi tool;
- a custom Pi fork solely to add `invokeTool` before the direct-adapter spike is measured;
- OptMem/Memory, workspaces, environments, snapshots, or policy languages;
- just-bash integration or host-shell replacement;
- retry policies beyond a deterministic test adapter;
- custom metrics storage, tracing backend, UI graph, cost platform, or cross-process propagation;
- generic Queue/PubSub infrastructure before a concrete multi-consumer event stream exists;
- production rendering parity beyond enough output to compare behavior.

## Proposed module boundary for the spike

```text
src/
  extension/
    index.ts                    # Pi events, one execute tool, session runtime ownership
    prompt.ts                   # minimal model-facing world contract

  evaluator/                    # reused from pi-rlm; no Effect services inside guest code
    manager.ts                  # existing EngineManager
    guest.ts                    # existing evaluator + engine-owned world facade
    transform.ts
    protocol.ts
    npm.ts
    lifecycle.ts                # existing restore-on-acquire behavior

  world/
    facade.ts                   # Promise/object API installed in guest
    bridge.ts                   # request routing, Schema decode, safe result/error encoding
    handles.ts                  # ergonomic AgentHandle facade; no runtime identity persistence

  domain/
    agent-id.ts                 # AgentId and AttemptId, distinct from Fiber/PID/Pi session
    agent-result.ts             # terminal result algebra
    errors.ts                   # tagged, safe boundary failures
    schemas.ts                  # bridge/process payload schemas only

  services/
    Authority.ts                # operation/resource authorization contract
    Agents.ts                   # spawn/wait/cancel Effect contract
    Web.ts                      # search Effect contract

  adapters/
    authority-static.ts         # explicit spike grants
    pi-process-agents.ts        # acquire process; scoped TERM/grace/KILL; exit -> completion
    codex-conversion-web.ts     # adapts supported Codex web implementation; owns no evaluator code

  runtime/
    live.ts                     # Layer.mergeAll + ManagedRuntime
    tracing.ts                  # named spans and in-memory exporter wiring

test/
  evaluator.contract.test.ts    # copied behavior specification
  agents.lifecycle.test.ts      # fan-out, wait, timeout, cancel, shutdown
  world.bridge.test.ts          # Promise facade + schema/error boundary
  web.composition.test.ts       # hidden Codex capability composition
  tracing.test.ts               # execution graph parentage
  comparison.test.ts            # old pi-rlm vs spike scenarios
```

The important seams are `evaluator <-> world.bridge`, `services <-> adapters`, and `Effect runtime <-> Promise facade`. If the spike keeps those three seams small while deleting polling and special-cased evaluator capability code, Effect is earning its place. If it does not, patch pi-rlm instead.
