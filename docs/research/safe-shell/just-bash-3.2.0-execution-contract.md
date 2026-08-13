# just-bash 3.2.0: usable security and execution contract

> Resolution for pi-world issue #16. Sources are pinned to just-bash commit [1fbde34](https://github.com/vercel-labs/just-bash/tree/1fbde341d74ff7f933d9cead9a390a6ab65b5df3) (version 3.2.0). Research only; no shell model implementation.

## Answer

just-bash is a Bash-like AST interpreter over an explicitly supplied filesystem. Each exec has isolated shell state but shares the Bash instance filesystem; cancellation is cooperative; resource accounting is bounded; network and extra runtimes are opt-in. It is suitable as a constrained virtual environment, not as a host shell or hard-isolation boundary.

## Contract

### Syntax and state

The README promises pipes, redirections, chaining, variables, positional parameters, globs, conditionals, functions, local variables, and for/while/until loops ([README shell features](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/README.md#shell-features)). Bash.exec parses source to an AST and invokes the interpreter ([Bash.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/Bash.ts)); it is Bash-like, not complete GNU Bash (the repository records known limitations in [KNOWN_LIMITATIONS.md](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/spec-tests/bash/KNOWN_LIMITATIONS.md)).

Every public exec copies environment, functions, arrays, shell options and cwd, then restores the prior state. The filesystem is shared across calls ([README quick start](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/README.md#quick-start), [Bash.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/Bash.ts)). Per-exec env, replaceEnv, cwd, stdin and args are temporary ([types.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/types.ts)). Thus one Bash instance is a persistent virtual workspace, not a persistent shell session.

### Filesystem

Default InMemoryFs has no disk access; initial files and a virtual Unix layout are supplied by the host. Retained bytes are bounded by maxFileSystemBytes (normal 1 GiB; hardened 128 MiB) ([limits.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/limits.ts), [in-memory-fs.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/fs/in-memory-fs/in-memory-fs.ts)). Lazy files materialize on first read and cache. OverlayFs reads a real root but keeps writes in memory; ReadWriteFs gives direct real-directory access ([README filesystem options](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/README.md#filesystem-options)). For pi-world, default to InMemoryFs and make any mount explicit and workspace-scoped.

### stdin and results

exec options provide finite stdin (UTF-8 text by default or explicit byte-shaped input); pipeline stdin is byte-oriented ([Bash.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/Bash.ts), [types.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/types.ts)). Results are stdout, stderr, exitCode and env. Parse errors are 2, execution limits are 126, abort/deadline is 124 ([Bash.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/Bash.ts)). Aggregate output defaults to 256 MiB normal / 10 MiB hardened, so pi-world needs a smaller transport/presentation cap ([limits.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/limits.ts)).

### Abort and budgets

An exec owns one ExecutionScope. Signals are checked cooperatively at statement/command boundaries and propagated to nested interpreters. Nested bash, xargs and similar calls share command, work, input, live-byte, output and depth budgets ([execution-scope.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/execution-scope.ts), [execution-scope.test.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/security/limits/execution-scope.test.ts)). Normal defaults include 64 MiB source, 100,000 commands/loop iterations, 100,000,000 work units and a one-hour wall deadline; hardened tightens these ([limits.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/limits.ts)). Abort is not preemptive for synchronous JS or uncooperative extensions.

Custom commands run in the embedding process and are trusted by default; trusted:false selects the restricted extension boundary ([custom-commands.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/custom-commands.ts)). Context capabilities are revoked on cancellation and cleanup is bounded, but arbitrary host code cannot be forcibly stopped; upstream recommends a worker/process for hard external-side-effect guarantees ([README custom commands](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/README.md#custom-commands), [custom-command-deadline.test.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/custom-command-deadline.test.ts)).

### Network and runtimes

Network commands are absent unless network/fetch is configured. The network layer supports exact origin/path allow-listing, GET/HEAD defaults, redirect rechecks, response and timeout limits, header transforms, and optional DNS/private-range denial ([README network](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/README.md#network-access), [network/types.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/network/types.ts), [allow-list.ts](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/network/allow-list.ts)). Full internet is explicitly dangerous. Python and js-exec are disabled by default and add runtime/WASM surface; SQLite is WASM/worker-backed ([README optional capabilities](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/README.md#optional-capabilities)).

### Threat boundary

Upstream explicitly says there is no VM isolation. Defense-in-depth protects against many prototype/host escape vectors but is secondary; same-realm cached references cannot be fully revoked. Complete containment requires a worker/process/container/full VM ([README security model](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/README.md#security-model), [security types](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/security/types.ts), [defense box](https://github.com/vercel-labs/just-bash/blob/1fbde341d74ff7f933d9cead9a390a6ab65b5df3/packages/just-bash/src/security/defense-in-depth-box.ts)).

## pi-world guidance

1. Expose a capability such as world.shell.exec, not Bun.$ or a host shell.
2. Use InMemoryFs by default; explicit read-only/workspace mounts only.
3. Use hardened limits plus stricter pi input/output/time caps; preserve 124/126/2 distinctions.
4. Pass stdin as data; never inherit process stdin. Treat abort as cooperative.
5. Do not expose model-authored custom commands unless reviewed, least-authority and trusted:false; isolate hard side effects in a worker/process.
6. Keep network, Python, JavaScript and full-internet modes disabled absent an explicit authority decision.

## Decision fog exposed

- Filesystem lifetime: per session, workspace, or cell? Per-cell loses files; per-session risks residue.
- Project-specific input/output caps and truncation policy; upstream normal/hardened budgets are not presentation policy.
- Whether cooperative cancellation suffices or optional/custom code needs a terminable worker.
- Which mounts, network origins/methods/header transforms and custom commands are granted.
- Whether OverlayFs/ReadWriteFs are allowed and how workspace boundaries are enforced.

## Verification

Existing local context already says just-bash is a constrained virtual environment, not host-shell replacement: [docs/research/pi-rlm-effect-v4-substrate.md](../pi-rlm-effect-v4-substrate.md); [ARCHITECTURE.md](../../../../ARCHITECTURE.md). No source implementation changed. The local gate bun run check passed.

Pinned upstream verification: after install and build, seven focused suites (Bash.general, exec options, custom commands, custom-command deadline, execution scope limits, variables, loops) passed: 259 tests. The full upstream test:run was attempted; 15,374 tests ran and 100 failed, chiefly optional Python/SQLite/QuickJS worker and bundle/runtime-environment cases plus performance/security environment-sensitive tests. This is recorded rather than calling the full upstream suite green.
