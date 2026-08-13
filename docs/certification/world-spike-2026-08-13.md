# Effect-native World spike certification

Date: 2026-08-13  
Issue: #9  
Commit tested: 04ab6d4

## Decision

**Go: keep strategy B and treat this repository as the merge-ready experimental @aivv/pi-world spike.** The observed behavior answers the spike question: the pi-rlm evaluator remains compatible while Effect owns a session-scoped three-child fan-out and a separately composed hidden Codex web capability. None of the research note's stop conditions occurred.

This is not a claim of durable agents or crash recovery. Agent identities, processes, and ergonomic handles remain scoped to one live Pi session; abrupt host death and attempt reconciliation remain outside the spike. The pinned Codex deep import is an experimental compatibility seam, not a stable upstream provider API.

## Environment

- Linux 7.1.8 x86_64;
- Bun 1.3.14 and Node 26.4.0;
- repository-local Pi 0.84.0 CLI;
- effect 4.0.0-rc.108;
- pi-codex-conversion 3.0.14;
- authenticated openai-codex/gpt-5.6-luna parent and children.

The system pi happened to be older, so certification prepended node_modules/.bin to PATH. Children therefore used the same 0.84.0 CLI as the parent. Credentials were resolved by Pi and the Codex adapter; no credential value was printed, copied, or saved here.

## Full gate

The gate was run in isolation (without another suite competing for guest pipes).

~~~text
$ bun run check
266 pass
0 fail
928 expect() calls
Ran 266 tests across 15 files. [42.11s]
~~~

This includes typecheck, Biome, the full evaluator contract suite, lifecycle and bridge tests, tracing privacy tests, and the independently executed pi-rlm 0.4.0 evaluator comparison.

## Opt-in live transcript

The parent was launched non-interactively with extension discovery disabled and this repository's extension loaded exactly once:

~~~text
PATH=<repo>/node_modules/.bin:$PATH \
PI_RLM_SUBAGENT_MODEL=openai-codex/gpt-5.6-luna \
pi -p --no-extensions -e <repo>/src/extension/index.ts \
  --provider openai-codex --model gpt-5.6-luna \
  --session-dir <temporary>/sessions --no-context-files <certification-prompt>
~~~

The one model-visible execute cell called world.agents.spawnMany for three tasks, awaited Promise.all over handle.wait(), called world.web.search for a benign public query, and projected the result to counts, tags, booleans, and binding types.

Redacted parent output:

~~~text
PASS — admissionElapsedMs: 54, uniqueIdCount: 3,
all child matches: true, webTextLength: 26686,
bindings: all functions.
~~~

The three Pi child session files were allocated at 14:32:18.902Z, 14:32:18.918Z, and 14:32:18.942Z. Their terminal writes occurred at 14:32:22.552Z, 14:32:22.278Z, and 14:32:22.526Z. Session allocation is the externally retained proxy for child start: all three allocations preceded the earliest terminal write by more than three seconds. All returned succeeded and three boolean token checks passed.

The parent transcript contains exactly one tool-call name, execute; neither web_run nor a World status/list operation was model-visible or invoked. After normal parent shutdown, pgrep scoped to the temporary root returned no process. The retained structural summary is therefore: childSessionCount 3, uniqueIdCount 3, succeededCount 3, tokenMatchCount 3, parentToolNames [execute], leftoverProcessCount 0.

Raw temporary sessions are intentionally not committed because they contain prompts and web content. This transcript retains only aggregate evidence and no IDs, PIDs, local paths, query result, raw output, sensitive environment variables, or auth material.

## Acceptance evidence

| Criterion | Evidence | Result |
| --- | --- | --- |
| Three starts precede first completion | Three live Pi session allocations precede the first terminal write; admission completed in 54 ms | Pass |
| Event-backed wait; no list/status polling | Live cell used handle.wait(); bridge and orchestration contracts expose no polling API | Pass |
| Cancel one while preserving siblings and await cleanup | Real-process lifecycle contract | Pass |
| Session close leaves no attached child | Session Layer cleanup contracts plus no live process under the temporary root | Pass |
| Wait timeout differs from execution timeout | Real-process lifecycle contract | Pass |
| Failure differs from cancellation and timeout | Real-process lifecycle contract | Pass |
| Hidden Codex search without web_run schema | Live search returned 26,686 characters; parent exposed/called only execute | Pass |
| Plain state and restart restore remain compatible | Full engine contract plus archived 70d45e6 comparison | Pass |
| Functions/live handles are non-durable | Engine and World bridge snapshot contracts | Pass |
| Required trace parentage | Privacy-safe in-memory tracer contract across session fibers | Pass |
| Less orchestration bookkeeping | Narrow structural contract: one World process-authority map versus multiple legacy maps, and no World polling registry | Pass |

Cancellation, timeout, nonzero exit, and forced shutdown use real OS child processes but deterministic local commands rather than paid model calls. The single opt-in paid run is reserved for behavior fixtures cannot prove: three genuine Pi sessions, real provider completion, and the package-owned Codex native web path.

## Stop-condition review

| Stop condition | Observed evidence |
| --- | --- |
| Codex needs copied auth/provider/native internals | No. Live search succeeded through the pinned executor; those concerns remain package-owned. |
| Agents needs Effect plus a second process authority map | No. World has one process record map; fibers observe event-backed completions. |
| Admitted fibers die with the bridge request | No. Three attempts outlived admission and completed after later waits. |
| Evaluator behavior requires a guest rewrite | No. Archived pi-rlm and fork engines produce identical normalized transcripts. |
| Hidden capability requires a model-visible schema | No. The live parent had only execute; hidden web search succeeded. |
| Bounded observable cancellation is not simpler | No. Session-scoped TERM/grace/KILL removes model polling and duplicate legacy registries. |

## Follow-up boundary

Proceed with the fork as an experimental package and keep the compatibility tests. Before calling World production-durable, separately design persistence, crash reconciliation, record retirement/output retention, resource-scoped AgentId authority, and an upstream-supported hidden Pi capability invocation seam. If the pinned Codex executor disappears and using it would require copied internals, stop at that future upgrade rather than absorbing those internals.
