# ARCH-pi-world: pi-world system overview

pi-world is a pi extension that replaces the model-visible tool surface with a
single `execute` tool running TypeScript in a persistent Bun evaluator, and
exposes a World facade (`world.agents`, `world.web`, `world.shell`) beside
the legacy `rlm` bindings.

## Components

- `src/engine/` — the evaluator. A host coordinator owns one Bun guest
  process; cells run one at a time over an authenticated loopback protocol; the
  namespace persists through per-variable snapshots and revives on evaluator
  rebuild. `test/engine.contract.test.ts` states each guarantee and why.
- `src/world/` — the World core: branded domain schemas and Effect service
  contracts (`domain.ts`, `services.ts`), a managed runtime factory
  (`runtime.ts`) composed with static authority checks (`authority.ts`),
  shell grants with mandatory audit (`shell-authority.ts`) over the
  non-executing Virtual Shell tracer (`deterministic-shell.ts`), Pi child
  process adapters (`pi-process-agents.ts`), the pinned Codex web seam
  (`codex-conversion-web.ts`), and privacy-safe tracing (`tracing.ts`). The
  guest-facing bridge (`bridge.ts`) is the single entry from guests into all
  of it.
- `src/extension/` — pi integration: composition root and tool registration
  (`index.ts`), per-session evaluator and World lifecycles
  (`session-engine.ts`, `session-world.ts`), bridged pi tools
  (`pi-tools.ts`), the replacement prompt (`prompt.ts`), and the legacy
  `rlm` subagent host with its TUI frames (`subagents.ts`, `frames.ts`,
  `render*.ts`, `stack-core.ts`). Session ownership of the World runtime is
  implemented here, not in the world core.

## Boundaries

- Dependency direction: extension depends on world; world depends on the engine
  only through `bridge.ts`'s host-request seam; the engine core stands alone.
- Trust boundary: the guest never supplies identity or authority. The bridge
  reconstructs subjects from host session context, and shell grants are proven
  and enforced host-side; guests send operation payloads only.
- Lifetime: one World runtime per pi session, surviving evaluator discard and
  rebuild, disposed at session shutdown after admitted child processes settle.
- The World Shell deliberately executes nothing today: the deterministic tracer
  proves the capability path while real Virtual execution remains a later slice.

Deep rationale, invariants, decisions, and failure modes live in
[ARCHITECTURE.md](../ARCHITECTURE.md); domain vocabulary lives in
[CONTEXT.md](../CONTEXT.md).
