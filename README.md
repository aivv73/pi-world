# pi-world

> **The agent's environment is itself a programmable object model.**

pi-world is a JavaScript-native persistent object world for agents, combining
RLM-style programmable context and recursive cognition with a continual,
eventually reflective harness. The agent interacts with context, tools, models,
agents, memory, and ultimately its own harness through one uniform object model.

It is an experimental [pi](https://pi.dev) extension that replaces the usual
toolbox with a single tool: **`execute`**, which runs TypeScript in a persistent
Bun evaluator.

Everything an agent would normally reach for a separate tool to do — reading
files, running shell commands, editing, searching, delegating to subagents — is
expressed as code inside that one tool.

This fork preserves the pi-rlm evaluator while it grows an Effect-native World
runtime. The source-grounded design lives in
[`docs/research/pi-rlm-effect-v4-substrate.md`](docs/research/pi-rlm-effect-v4-substrate.md); the completed Linux gate and opt-in three-child/Codex evidence is recorded in
[`docs/certification/world-spike-2026-08-13.md`](docs/certification/world-spike-2026-08-13.md).

```
 ✓ rlm · shell · const files = (await Bun.$`ls -1`.text()).split("\n") · ↑ 2 ↓ 7 lines · 41ms
 ✓ rlm · const tests = files.filter((f) => f.includes("test")) · ↑ 1 ↓ 1 lines · 3ms
```

The second cell reuses the first cell's variable. Nothing was re-read, and
nothing was re-parsed from text — because the evaluator is still there.

## Why one tool

A fixed set of tools is a fixed vocabulary. Every new capability means a new
tool, a new schema, and a model that has to be taught when to reach for it.

Here the vocabulary is a programming language. Capabilities arrive as functions
in the evaluator's namespace rather than as entries in a tool list, so the
interface the model sees never changes while what it can do keeps growing. It
also changes how an agent works: intermediate results live in variables instead
of being re-derived from earlier output, so a long task compounds rather than
repeating itself.

## What the agent gets

**Subagents as a call stack.** A cell that calls `rlm.run` renders its
children as stack frames beneath it — glyph, name, status, age, spawn site —
nested by depth. While anything runs the stack stays visible on the collapsed
cell; once every frame settles it folds into a header chip (`3 subagents ·
1 failed`). Frame records live on disk beside each child's output, so stacks
survive session resume and read truthfully post-mortem.

**A namespace that persists.** Variables, functions, classes, and imports stay
available across calls, across turns, and — on a best-effort basis — across
session resumes. Whatever cannot be serialised is named in the restore report
rather than silently dropped. Long sessions stay cheap: snapshots re-serialise
only what changed, large long-untouched values revive lazily (they load the
first time they are read), and `rlm.forget("name")` is the one true delete —
the engine never discards agent state on its own.

**Shell as values, not text.** `await Bun.$`git log --oneline`.quiet()` returns an
object with an exit code and captured output, ready to be assigned and filtered.
No parsing a transcript to recover what a command said.

**World agents as event-backed calls.** `await world.agents.spawn("task")`
returns an ergonomic handle at admission; `wait()` settles from process close
and `cancel()` awaits bounded cleanup. `spawnMany()` admits a fan-out before
anything is awaited. Legacy `rlm.run` remains available for compatibility.

**Cancellation that costs one cell.** Interrupting a running cell leaves the
namespace intact, and the cancelled cell cannot keep writing to it afterwards.

## Install

```bash
pi install npm:@aivv/pi-world
```

**[Bun](https://bun.sh) is required.** pi itself runs on Node, but the evaluator
is a Bun process — without it on your PATH the engine will tell you so and stop.

```bash
curl -fsSL https://bun.sh/install | bash
```

## Launch

The installed package is always active. A normal Pi session collapses the
model-visible tool surface to `execute`, replaces the system prompt, and mounts
live `world`, `rlm`, and `tools` evaluator bindings:

```bash
pi
```

To run from a clone, load the extension explicitly:

```bash
git clone https://github.com/aivv73/pi-world && cd pi-world
bun install
pi --no-extensions -e ./src/extension/index.ts
```

World children use the same `--no-extensions -e <this fork>` shape, so an
installed copy cannot load a child extension twice.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_RLM_SUBAGENT_MODEL` | `anthropic/haiku` | Model children are spawned with |
| `PI_RLM_MAX_DEPTH` | `2` | How deep recursive delegation may go |
| `PI_RLM_DEPTH` | `0` | Depth of the current agent; set on children automatically |
| `PI_RLM_NPM_CACHE_DIR` | `~/.cache/pi-rlm-npm` | Where `npm:` imports install |

Session state lives in `.pi-rlm/<session>/`: the namespace snapshot and each
subagent's session file and output.

### npm imports

Static top-level imports can name npm packages directly:

```ts
import { z } from "npm:zod@4";
import { format } from "npm:date-fns@4/format";
```

The first import of a `name@version` installs it into an isolated cache
directory — the working directory's `node_modules` is never touched — and the
binding persists across cells like any other import. Pin versions when
repeatability matters: an unpinned name means `latest`, resolved once at first
install and reused from the cache after that. Specifiers are
code-execution input: importing a package runs its code. Dynamic
`import("npm:...")` is not supported.

## How it works

The extension runs a Bun child process that owns the namespace. Cells are
transformed so their top-level declarations become namespace assignments, then
executed inside a `with` block over a proxy. Host and guest talk over a private
loopback connection with authenticated framing, which is what stops a cell from
being able to report its own outcome.

[ARCHITECTURE.md](ARCHITECTURE.md) covers the evaluator design and reasoning. The
[Effect v4 substrate note](docs/research/pi-rlm-effect-v4-substrate.md) records the
World spike's source-grounded design and stop conditions.

## Development

```bash
bun run check      # typecheck, lint, and the full suite — the gate
bun test           # tests only
bun run typecheck  # tsc --noEmit
bun run format     # biome
```

The test suite is the specification. `test/engine.contract.test.ts` states each
guarantee the evaluator makes and why it exists; read it before changing engine
behaviour, and never weaken a case to make a change pass. The `PI_RLM_*` variables
and `.pi-rlm/` session directory remain compatibility surfaces for this fork.

## Layout

```
src/engine/      the evaluator
  index.ts       EngineManager — host side: lifecycle, queueing, output, snapshots
  guest.ts       the Bun process that owns the namespace and runs cells
  protocol.ts    typed, authenticated framing between the two
  transform.ts   cell source → executable body
  npm.ts         lazy, isolated installs behind npm: imports
src/extension/   the pi integration
  index.ts       always-on tool registration and session wiring
  session-world.ts  session-owned Effect runtime and scope
  prompt.ts      the system prompt
  subagents.ts   spawning, registry, file-based results
  render-core.ts cell layout (pure)
  render.ts      binds pi's theme and width primitives to it
src/world/        experimental Effect-native runtime core
  domain.ts       IDs, schemas, terminal results, and safe errors
  services.ts     Authority, Agents, and Web contracts
  bridge.ts       schema/authority boundary for the guest world facade
  runtime.ts      Layer composition and ManagedRuntime factory
  pi-process-agents.ts  session-scoped Pi child process adapter
  codex-conversion-web.ts  isolated pinned Codex web adapter
  tracing.ts      privacy-safe semantic spans and in-memory test tracer
```
