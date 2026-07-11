# Oxagen Rust CLI — Lessons-Learned Registry (binding)

Every entry below is a defect, near-miss, or hard-won discovery from the
TypeScript CLI/engine (2025–2026), converted into a **binding requirement**
for the Rust build. This is not a retrospective; it is part of the spec
(`01-product-spec.md` non-negotiable #10). A PR that violates an entry must
amend this registry first, with justification.

ID scheme: `L-<category><n>` — **T** terminal/TUI, **E** engine loop,
**M** model layer, **C** context, **S** tools/safety, **L** lifecycle,
**V** verification, **P** process/CI. Sources cite the TS PR or incident.

## T — Terminal / TUI

| ID | What TypeScript taught us | Binding Rust requirement | Source |
|---|---|---|---|
| L-T1 | Rebuilding the REPL as an **event-log renderer** (envelope v1, Mission Control) fixed a class of state-drift bugs: UI derived from ad-hoc component state went stale; UI derived from the event stream cannot. | The TUI renders exclusively from `AgentEvent`s (`02-architecture.md` §4). No panel may own state that isn't reconstructible by replaying the event log; replay-from-seq-1 is a supported debug mode (fleet `watch` already worked this way). Envelope versioning is additive-only within a major version, and parsers tolerate torn tails — a crashed writer must never poison readers. | PR #664, ADR-023 |
| L-T2 | Enabling terminal mouse-tracking broke native text selection/copy — users couldn't copy output with their terminal's own selection. | Mouse reporting is **off by default**; any mouse-dependent feature must degrade to keyboard and must never cost native copy. | PR #655 |
| L-T3 | Large pastes flooded the input buffer and the model context. Collapsing to a `[head … N lines … tail]` chip that expands on demand fixed both. | Paste capture with chip collapse above a small line threshold; the full payload attaches to the turn, never renders raw in the composer. | PR #655 |
| L-T4 | Ink 7 clipped **both** box edges during scroll; line-exact `clipTop` math was required for a usable scrollback and `/diff` viewer. | Viewport/scroll math is line-exact and property-tested at boundary offsets (first line, last line, exact-fit, over-fill). Diff viewing is a first-class panel, not pager shell-out. | PR #682 |
| L-T5 | The files-touched panel required patching an `onFileEdit` callback into **two** pipeline switches — a second data path that had to be discovered and kept in sync. | File-edit diffs ride the single event stream (`FileChange { diff }`). There is no second callback path to forget. | PR #877 |
| L-T6 | TUI tests with fixed sleeps flaked; tests asserting on ANSI-colored strings broke on environment differences (tsc and gh colorize even when piped). | TUI tests poll with deadlines (`until()`-style), never fixed sleeps, and assert on the backing cell buffer / stripped text, never raw ANSI. | ink-tests-poll memory; tsc-ANSI incident |
| L-T7 | A child-component throw swallowed by an incomplete test mock rendered a blank frame with dead input — the worst failure mode: silent. | Render errors are loud: a TUI panel that panics is caught at the panel boundary, rendered as a visible error card with the message, and recorded as an `Error` event. Blank-screen-with-dead-input is a released-blocking bug class. | ink-blank-frame memory |
| L-T8 | A persistent debug channel (`OXAGEN_CLI_DEBUG=1` → log file + a `logs` command) repeatedly turned "cannot reproduce" into a file path. | `OXAGEN_DEBUG=1` writes structured logs to `~/.local/state/oxagen/logs/`; `oxagen logs` tails them. Ships in v1, not later. | cli-debug-log memory |

## E — Engine loop

| ID | What TypeScript taught us | Binding Rust requirement | Source |
|---|---|---|---|
| L-E1 | `StageKind` lived in **two copies** (engine + CLI trace) that drifted; even after consolidating the CLI copy to a re-export, a hand-mirrored zod schema of it survives in the session-event wire format (`apps/cli/src/sessions/events.ts` `stageKindSchema`) and still needs manual sync. | One stage vocabulary, one crate (`oxagen-protocol`); wire schemas are **derived** from the same types (serde), never hand-mirrored. Duplicated protocol types are a review-blocking defect. | PR #535; stageKindSchema mirror |
| L-E2 | Running the full plan→execute→judge pipeline on simple lookups wasted seconds and tokens; classifying prompts and skipping planner+judge for lookups (and single-task goals) was a large UX win with no quality loss. | Triage classification runs on every prompt (cheap role, `07-model-matrix.md`); classified simple prompts take a direct path with planner and judge skipped — **and the judge-skip self-revokes if the turn unexpectedly touches files (zero-diff guard)**; single-task goals (deterministic pattern check that errs toward planning) skip DAG planning. Fast paths are tested for *correct downgrade* (a misclassified complex task must still complete, just slower). | PRs #654, #663 |
| L-E3 | Compaction that summarized without deduplicating first wasted the budget on repeated identical tool outputs. | Compaction pipeline: dedup identical/near-identical tool outputs → evict by budget → summarize; stable system prefix preserved for prompt caching. Property test: compaction never drops a still-referenced tool result. | PR #875 |
| L-E4 | Blanket-raising turn timeouts to accommodate one slow operation (CI waits) degraded every turn. The winning design: timeouts on the **model call** (retry without ending the turn); turn liveness guarded by **progress, not clock** (inactivity timer resets on any completed call and defers while a tool is in flight); external waits extend the window only on confirmed-pending evidence, cumulatively capped (CI: 2h). | Per-call timeouts by role; a progress-based stall detector owns turn liveness; long external waits (CI watch, video jobs) extend it only with fresh evidence and under their own cumulative caps — never by raising a global turn timeout. | PR #549; timeouts.ts, ci-wait.ts |
| L-E5 | Auto-executing large plans surprised users; an interactive **scope-review gate** (plan card, approve/trim) before big work restored trust without slowing small tasks. | Above configurable thresholds (files touched / steps / estimated cost), interactive sessions present a `ScopeReview` event card and wait; headless requires a flag to bypass. | PR #661 |
| L-E6 | Feeding the planner the whole transcript made planning slow and noisy; a **split planner context** (goal + recall + structure, not raw history) planned better. | The planner receives a purpose-built context assembly, not the accumulated message list. Context assembly per role is explicit and testable. | PR #875 |
| L-E7 | Head-to-head SWE-bench runs: disciplined **single-shot beat multi-attempt** configurations on cost-per-resolve; best-of-N is a lever, not a default. | Default is single-shot. Best-of-N is opt-in (`--candidates N`) with a published cost/resolve curve (`04-benchmark-strategy.md`). | SWE-bench head-to-head memory |
| L-E8 | Memory injected as a cached system block went stale; recall wired as a **live provider consulted before acting** stayed correct. | Memory recall is a context-plane query at turn start (and on-demand via tool), never a cached prompt block; recalled frames ride as a volatile message *after* the byte-stable system block, preserving prompt-cache hits. | PR #437; ADR-021 cache discipline |
| L-E9 | Fleet/subagent fan-out hand-rolled per call site diverged (lineage lost, budgets uncounted); one dispatch/aggregate seam fixed it. | Subagent dispatch goes through one `oxagen-fleet` API that stamps lineage into the ledger and meters child spend into the parent budget. No ad-hoc process spawning for agents. | agent.subagent.dispatch design; fanout phase 2 |
| L-E10 | Streaming UI events emitted during a step that later failed and was retried could not be retracted from the wire — consumers saw ghost effects from doomed attempts. | The step loop buffers per-step side-effect events and flushes them only when the step commits; a retried step emits nothing from the failed attempt. No consumer ever needs a retraction message. | engine.ts deferred-flush design |
| L-E11 | Model judges alone rubber-stamped plausible-but-unverified work. The winning design: a deterministic spec-first oracle — only a **fail→pass flip of the same normalized test command** counts as verification (a test that never failed proves nothing; linters/typecheckers excluded) — plus an evidence ladder that submits fast and **skips the judge entirely** when flip + touched-tests-green + diff-size budget all hold. | Verification is deterministic-first: the flip-oracle state machine (`none→failing→flipped`) and evidence ladder decide submit/revise/fork before any model judge runs; model judges handle only inconclusive evidence, always on a different model than the worker, with a heuristic fallback verdict if the judge call itself fails. | spec-test oracle (F2) + verification ladder (F3), swe-rank1-scalpel spec; ADR-021 |

## M — Model layer

| ID | What TypeScript taught us | Binding Rust requirement | Source |
|---|---|---|---|
| L-M1 | A phantom model slug (`glm-5.2-turbo`) entered the code, resolved against nothing, and produced dead behavior discovered late. | Unknown slug = immediate hard error naming the catalog refresh command. No call site hard-codes a slug; the catalog (`07-model-matrix.md` §3) is the only source of model ids. | PR #886 |
| L-M2 | Gateway model-slug drift broke resolution repeatedly; the fix was always "verify against `/models`, resolve through one function (`modelIdOf`)". | `oxagen models refresh` pulls provider `/models`; the router is the single resolution point; CI has a catalog-freshness lint for the seed data. | AI Gateway slug-drift gotcha |
| L-M3 | Making "auto" a *string sentinel* leaked pseudo-slugs into resolver paths (dead-resolver regression); making it the *absence of a pin* (`model: null`) was clean — but test mocks then needed explicit model ids. | Selection is `Option<ModelRef>`; no `"auto"` string exists in any type. Test fixtures always pin explicit models. | PR #886 |
| L-M4 | Deterministic fast paths that internally retried LLM calls weren't fast; `maxRetries: 0` with graceful fall-through made them deterministic in latency too. | Triage/classification calls run with `max_retries = 0` and a hard latency ceiling; on failure they fall through to the full path — never hang, never retry. | PR #875 |
| L-M5 | An SDK minor version moved token-usage fields (cache reads nested under `inputTokenDetails`) and silently broke local cost aggregation. | Usage parsing is adapter-owned, normalized into one envelope, and covered by per-provider recorded-fixture tests that fail loudly on shape drift. | AI SDK v7 usage-shape memory |
| L-M6 | Per-function model overrides (`/triage-model`, `/judge-model`, `/worker-model`) let users tune cost/quality per role — one global model was never right. | Role-based routing is the core abstraction (`07-model-matrix.md` §1), with per-role config + slash commands from day one. | PR #659 |
| L-M7 | Provider outages cascaded until circuit breakers were installed at every vendor seam. | Every adapter carries a breaker (open after N transport failures → loud fallback event → next configured family). No silent mid-turn family switches. | PR #570 |
| L-M8 | BYOK-without-login (env key → works immediately) was the single most appreciated onboarding property. | Any single provider key yields a fully working agent (`07-model-matrix.md` §5); first-run with zero config and one env var must reach a working prompt in one step. | PRs #462/#487 |

## C — Context

| ID | What TypeScript taught us | Binding Rust requirement | Source |
|---|---|---|---|
| L-C1 | Building the code-graph lazily on first query added seconds to the first real prompt; **warming at mount** hid the cost in startup slack. | Index open + incremental catch-up starts at session mount (background task), not at first query. First-query p95 is a tracked bench number. | PR #654 |
| L-C2 | Re-embedding unchanged content wasted minutes and API spend; byte-compatibility checks that skip re-embedding, plus free local embedding backends, made indexing cheap enough to run always. | Embedding index keyed by content hash + `EmbedderFingerprint`; byte-identical content is never re-embedded; the default embedder is local and free (`06-context-protocol.md` §4). | code-graph embeddings split |
| L-C3 | Facts that were **deleted** on correction destroyed history and broke "what did we believe when". Bi-temporal validity (valid time + transaction time) with supersede-not-delete preserved both truth and audit. | Fact edges carry bi-temporal intervals; corrections close and supersede, never delete (`06-context-protocol.md` §2.2). | PR #563 |
| L-C4 | Showing raw UUIDs as identifiers made graph output useless to humans; the rule "cite by human label, id only in a copyable detail view" plus a typed @-mention grammar made references usable and machine-parsable. | Every graph/context surface (TUI, `context search`, frames) presents `display_name` labels; raw ids appear only in inspectable detail. `ContextFrame.citation_label` is mandatory. Mentions in prompts use a typed grammar and are treated as retrieval anchors. | UI citation rule; PR #788 |
| L-C5 | Context assembled from many sources without cost accounting silently starved the parts that mattered. | Frames carry `token_cost`; assembly is budget-packed with an explicit dropped-report; the `ContextRecall` event exposes the final mix (`06-context-protocol.md` §2.3). | engine compaction lineage |
| L-C6 | Graph-first retrieval needed an honesty check: when graph coverage of a query fell below a threshold, serving weak graph frames was worse than falling back to plain bounded lexical search. | Retrieval computes a coverage score; below threshold the plane falls back to bounded grep-style search and labels those frames as lexical fallback — weak graph context is never dressed up as grounding. | context-resolver MIN_COVERAGE gate |

## S — Tools / safety

| ID | What TypeScript taught us | Binding Rust requirement | Source |
|---|---|---|---|
| L-S1 | Aborted bash left orphaned process groups; kill had to be process-group, signal-real, and timeout-backstopped. | `exec` creates a process group; abort/timeout kills the group; a leak test is in CI. | gap audit P1 |
| L-S2 | File tools pinned to launch cwd while `bash cd` / worktree switches moved the shell — the two silently diverged (shipped twice: root pinning, then torn worktree-divergence path echo). | One workspace-root source of truth owned by `oxagen-tools`; `exec` reports its effective cwd in every result; file tools resolve against the pinned root and **warn loudly** when the shell cwd has diverged from it. | PR #874; commit f1005c5d |
| L-S3 | Naive head-truncation of tool output cut off failing-test tails — the only part that mattered. Middle-out (head+tail) truncation preserved the signal. | Output truncation is middle-out with explicit elision markers; the tail budget is at least as large as the head budget for exec output. | engine tools design |
| L-S4 | Under parallel load, spawning many login shells (`zsh -l`) starved the host and hung; one long-lived background runner with generous timeouts was stable. | Exec concurrency is bounded (semaphore); shells spawn non-login/non-interactive by default; fleet workers share a bounded executor rather than spawning freely. | host shell-spawn starvation |
| L-S5 | Search tooling that ignored `.gitignore` (or hand-rolled walkers) produced noise and missed-file bugs; ripgrep semantics were the fix everywhere. | `grep`/`glob` are ripgrep-semantics by contract (gitignore-aware, hidden-excluded, `-uu`-style escape hatch), whether shelling to `rg` or using the `ignore` crate fallback. | fast-search policy |
| L-S6 | The four-mode permission broker (readonly / ask / acceptEdits / bypass) only worked with two hard rules layered on top: **settings-level deny beats bypass**, and dangerous-command detection (recursive rm, curl-pipe-sh, force-push to default branch, writes outside the workspace root) **downgrades allow→ask** instead of trusting the mode. | Same broker semantics in the tool permission gate: deny always wins (even over bypass); only mutating tools are gated; dangerous-pattern escalation downgrades to ask in every mode. Hook order: settings deny → mode → escalation. | permissions.ts broker design |

## L — Lifecycle

| ID | What TypeScript taught us | Binding Rust requirement | Source |
|---|---|---|---|
| L-L1 | Calling `process.exit` from a signal handler while native libraries (DuckDB, ONNX) held locks caused hard mutex aborts on Ctrl-C; the fix re-raised the signal after cleanup so exit codes stayed conventional. | Signal handlers only request cancellation; shutdown drains events, closes SQLite/ONNX/llama.cpp handles owned by one shutdown-aware runtime struct, then **re-raises the signal with default disposition** so callers observe 128+n. A kill-during-indexing consistency test gates Phase 3. | PR #786; exit-by-signal.ts |
| L-L2 | Built-in skills resolved from filesystem paths broke the moment the artifact was bundled differently; embedding them as module data was the fix. | Built-in assets (seed catalog, prompt profiles, tree-sitter queries, skill templates) are `include_str!`/`include_bytes!` compile-time data — nothing resolves relative to the binary's install path. | PR #713 |
| L-L3 | Top-level fallible platform-specific initialization (a `createRequire` at module scope) crashed the whole process at boot in a different runtime; lazy + guarded init was the fix. | Anything fallible or platform-specific initializes lazily behind the first use, after arg parsing — `oxagen --version` and `--help` must never touch providers, storage, or native libs. | createRequire boot-crash memory |
| L-L4 | Unmaintained/ABI-incompatible dependencies (CJS plugins under ESM ink 7) cost days; vendoring small ones beat fighting them. | Dependency policy: prefer std/small pure-Rust deps; `cargo deny` gates licenses; a dep that breaks builds twice gets vendored or replaced, recorded in an ADR. | ink7 CJS incompat |

## V — Verification

| ID | What TypeScript taught us | Binding Rust requirement | Source |
|---|---|---|---|
| L-V1 | Tests that pass for the wrong reason (over-broad mocks, asserting on the mock, sleeping past races) repeatedly masked real defects. | Test review asks "why does this pass?" — mocks are minimal (spread-the-real-module style, never full replacement that drops sibling exports); every bugfix lands with a regression test that fails on the pre-fix code. | robust-fix policy; vitest mock-spread incident |
| L-V2 | LLM output used as an artifact (code, config, SVG) must be **mechanically post-validated** — schema checks, compilation, parsing — never trusted because it "looked right". | Every generated artifact passes a deterministic validator before it is written or returned (SVG: usvg parse+sanitize; code: syntax check where cheap; structured output: schema-enforced with bounded repair loops). | PRs #673/#674 |
| L-V3 | Status surfaces that reported cached/DB state ("running") for resources that were actually gone destroyed trust; live reconciliation before reporting fixed it. | Anything that claims external state (video jobs, PR/CI status, OCP provider health, fleet workers) reconciles against the source before rendering; stale cache is labeled as such. | sandbox lifecycle truthfulness |
| L-V4 | Unit tests against fully-mocked stores passed while shipping invalid SQL; only recorded fixtures + one live path caught wire-level breakage. | Per-provider recorded-fixture suites (chat, media, embeddings) + one keyed live smoke per release. Mock-only coverage is never claimed as provider compatibility. | ClickHouse mocked-SQL incident |

## P — Process / CI (for the Rust repo's own hygiene)

| ID | What TypeScript taught us | Binding Rust requirement | Source |
|---|---|---|---|
| L-P1 | Affected-only CI let stale surfaces rot (CLI-only pushes skipped app e2e; dispatch-green ≠ suite-green); main needed the full gate. | PRs run affected crates; pushes to the default branch run the **full** workspace suite + conformance + bench smoke. Per-job verification, not whole-run status. | e2e affected-drift; main full-gate |
| L-P2 | Coverage thresholds set razor-thin failed CI on environment noise; ratchets with headroom (never lower, cap, ~2.5% slack) held the line without flakes. | `cargo llvm-cov` gates ratchet up only, capped (85→90 target per `01-product-spec.md`), always with headroom below actual. | coverage-ratchet policy |
| L-P3 | Benchmark configs tuned against the eval set p-hacked themselves; pre-registration and held-out dev subsets kept claims honest. | Already binding in `04-benchmark-strategy.md` §6 — listed here so the registry is complete. | bench fairness rules |

## Maintenance

- New lessons append here with the next id in their category; entries are
  never deleted, only marked `superseded-by:` when a stronger rule replaces
  them.
- Cross-references from other spec docs (e.g. `02-architecture.md` §8 →
  L-L1) are load-bearing; renaming an id requires updating them.
