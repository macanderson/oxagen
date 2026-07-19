# Oxagen CLI — Rust Port Strategy

> **Superseded/expanded by the `oxagen-rust-cli` spec**, which described
> rebuilding the CLI as a standalone, open-source, account-free,
> multi-provider BYOK Rust binary — a different target than this document's
> original framing (a platform-integrated CLI ported to Rust for speed).
> That effort has since been ejected from this monorepo: the agent lives in
> its own repository, and the Open Context Protocol crates live at
> `github.com/macanderson/opencontextprotocol` (the spec directory was
> removed along with `crates/`; see git history for both). The migration
> mechanics below (port-the-spec, golden-trajectory conformance, strangler
> pattern) still apply.

Goal: the most performant (highest resolve rate), most efficient (lowest token burn), and fastest (lowest wall-clock) agentic coding CLI. Rust is the vehicle for *fast* and for a single distributable binary — but the score lives in the **loop logic, prompts, and tool semantics**, which are language-independent. So: **finish and prove the design in TypeScript first, then port a frozen, well-tested spec.** Never port a moving target.

## Guiding principles

1. **Port the spec, not the code.** The TS engine (post-Phase-1) is the executable specification. Its ports are already JSON-serializable and its behaviors are pinned by tests — those tests become the Rust conformance suite.
2. **Strangler pattern, not big-bang.** Stand up `oxagen-core` (Rust) beside the TS CLI; move one capability at a time behind a stable boundary; keep both runnable and cross-tested until Rust is at parity, then flip the default.
3. **Golden trajectories are the contract.** Record real TS-engine runs (deterministic where possible: fixed seed, recorded model responses) as golden JSONL. Rust must reproduce them event-for-event on the same recorded inputs. This is what makes "Rust is tricky" safe — parity is mechanically verifiable, not vibes.
4. **The LLM is the slow part.** Rust's speedup is in everything *around* the model call (fs walks, grep, diff, graph queries, process spawning, JSON, startup) — real for wall-clock and a snappy TUI, but it does not change the resolve rate. Keep expectations honest: Rust buys speed + distribution + memory safety, not accuracy.

## Boundary (where TS and Rust meet during the migration)

The engine already talks to the world through ports. Freeze them as a **versioned JSON protocol** (the same shape as `--output-format stream-json` plus tool-exec requests):

- **Requests** (driver→host): `read_file`, `write_file`, `edit_file`, `list`, `glob`, `grep`, `exec`, `diff`, `code_graph`, `code_map`, `model.stream`, `model.generateObject`, `memory.*`, `trace.record`.
- **Events** (host→driver / driver→UI): stage, text, reasoning, tool-start, tool-result, file-change, judge-verdict, retry, compaction, commit, pr, check.

Transport during migration: line-delimited JSON over stdio between the Rust binary and a thin TS "host" (or vice-versa), so either side can be swapped incrementally. Post-migration the whole thing is one Rust process and the protocol becomes internal trait boundaries.

## Crate layout

```
oxagen-core/           # pure loop: step-driver, compaction, retry, budgets, loop-detect.
                       #   No I/O — drives via the Host trait. This is the score.
oxagen-tools/          # Workspace impl: fs, rg-backed grep/glob, diff, process-group exec
                       #   (tokio + nix for signals/pgid — the audit's bash-leak fix, native).
oxagen-model/          # AgentAi over the AI Gateway: streaming SSE, tool-call parsing,
                       #   per-vendor reasoning options, per-call timeout+retry.
oxagen-graph/          # code-graph: tree-sitter (native, not WASM) incl. Python edges; DuckDB.
oxagen-pipeline/       # evaluate→enhance→route→execute→judge→revise; verifyWork; best-of-N.
oxagen-fleet/          # planner DAG, worktree isolation, commit ledger, PR/CI monitor.
oxagen-tui/            # ratatui REPL (maps 1:1 to the event vocabulary).
oxagen-cli/            # clap command tree; the single distributable binary.
oxagen-protocol/      # serde types for the boundary above; shared by every crate + the TS host.
```

## Sequenced migration (each step ships, both stacks cross-tested)

1. **Protocol + golden recorder** (in TS): finalize `oxagen-protocol` shapes; record golden trajectories from the passing TS engine (recorded model responses for determinism).
2. **`oxagen-tools`** first — highest speed win, lowest risk, easiest to verify (fs/grep/diff/exec have exact expected outputs). Run the TS engine against the Rust tools over the protocol; TS tool tests become Rust conformance tests. Native process-group kill + signal threading is cleaner in Rust than the Node detached-pgid dance.
3. **`oxagen-model`** — SSE streaming + tool-call parsing + reasoning options. Verify against recorded gateway responses.
4. **`oxagen-core`** — the step-driver/compaction/retry/budget logic. Replay golden trajectories: Rust core + recorded model + Rust tools must reproduce the TS event stream exactly. **This is the crux** — port it last among the engine internals, with the most tests, because it is the score.
5. **`oxagen-graph`** — tree-sitter native (drop WASM); parity-check symbol/edge extraction against the TS builder on a fixture repo, Python included.
6. **`oxagen-pipeline`** + **`oxagen-fleet`** — evaluate/judge/best-of-N; planner DAG + ledger + PR monitor.
7. **`oxagen-tui`** (ratatui) + **`oxagen-cli`** (clap) — last; the loop must be proven headless before a TUI rides on it. Flip the default binary; keep the TS CLI as an oracle for one release.

## Conformance & CI

- **Golden-trajectory replay** in CI: same recorded inputs → byte-identical event stream (TS ⇄ Rust). A divergence fails the build with the first differing event.
- **Bench parity gate**: Rust must match TS resolve rate on the sample set (±noise) before the default flips; same harness (`bench/swe-bench`), same profile.
- **Perf gates**: startup time, cold grep over a large repo, diff of a big change, TUI frame budget — Rust must beat the TS baseline (the point of the port) and never regress.
- **Property tests** for compaction (never drops a still-referenced tool result), budget eviction (monotonic), edit-match (fuzzy fallback never corrupts).

## What Rust changes vs. what it doesn't

- **Faster**: startup (no Node warmup), fs/grep/diff/graph (native + parallel via rayon/tokio), single static binary (no node_modules), lower memory, snappier TUI.
- **Safer**: process-group/signal handling, no unhandled-rejection class of bugs, deterministic resource cleanup (RAII worktrees/temp files).
- **Unchanged**: resolve rate (that's prompts + loop logic + model — ported faithfully, verified by golden trajectories). Token burn improves only insofar as the ported compaction/budget logic runs identically.

## Risk register

- **Streaming/tool-call parsing drift** across AI-SDK vs a Rust client → mitigate with recorded-response conformance tests before `oxagen-core` moves.
- **tree-sitter grammar parity** (WASM vs native versions) → pin grammar versions; fixture-diff the symbol/edge output.
- **Model nondeterminism** makes live parity noisy → determinism only claimed on recorded inputs; live comparison is statistical (bench parity gate), not exact.
- **Porting a moving target** → hard rule: freeze the TS spec (tag it) before step 4; spec changes go to TS first, re-record goldens, then Rust.
