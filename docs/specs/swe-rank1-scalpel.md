---
title: "SWE-bench Rank-1 Scalpel"
description: "Archived spec & plan — status: shipped (audited 2026-07-03)."
---

> **Status: Shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> All 10 features from the SWE-bench Rank-1 Scalpel spec have been implemented, tested, and wired into the agent-engine and CLI on main. The spec defines ten targeted optimizations (zero-token localization, spec-first oracle, adaptive ladder, cache-forked best-of-N, consensus selection, diff shrinker, hypothesis falsification, repo priors, memory filtering, diagnosis artifact) to maximize SWE-bench score while minimizing tokens and diff size. All feature modules exist with comprehensive unit tests (~350+ tests total), environment flags are registered, and the features are integrated into the pipeline and CLI via fork mode, ladder decision control, and prompt enhancement.

**Implementation evidence**

- docs/specs/swe-rank1-scalpel.md — Spec file with 10-feature design, build plan, dogfooding protocol
- packages/agent-engine/src/localize/index.ts — F1 deterministic zero-token localization module
- packages/agent-engine/src/oracle/spec-test.ts — F2 spec-test oracle state machine tracker
- packages/agent-engine/src/pipeline/ladder.ts — F3 adaptive compute ladder decision controller
- packages/agent-engine/src/fork/index.ts — F4 cache-forked snapshot + tail planner
- packages/agent-engine/src/evaluate/consensus.ts — F5 diff consensus and selection ladder
- packages/agent-engine/src/shrink/index.ts — F6 delta-debug diff shrinker (greedy reverse)
- packages/agent-engine/src/oracle/hypotheses.ts — F7 hypothesis falsification parser + probe pairing
- packages/agent-engine/src/priors/index.ts — F8 repo-prior store with legality lint
- packages/agent-engine/src/evaluate/diagnosis.ts — F10 structured diagnosis schema + extraction
- packages/agent-engine/src/memory/applicability.ts — F9 memory recall filter (2-stage, lexical + LLM)
- packages/agent-engine/src/localize/index.test.ts, oracle/spec-test.test.ts, pipeline/ladder.test.ts, fork/index.test.ts, evaluate/consensus.test.ts, shrink/index.test.ts, oracle/hypotheses.test.ts, priors/index.test.ts, evaluate/diagnosis.test.ts, memory/applicability.test.ts — 10 comprehensive test files, ~350+ tests total, passing
- packages/agent-engine/src/pipeline/index.ts — Ladder and spec-test wiring in main pipeline loop
- packages/agent-engine/src/pipeline/wiring.ts — F2/F3 integration helpers (spec-gate, ladder signals)
- apps/cli/src/agent/best-of-n.ts — Fork mode (snapshot/planForks/decideSelection imports), consensus selection ladder
- packages/agent-engine/src/evaluate/prompt-enhancer.ts — F1 localization + F8 priors + F9 recall filter wired into ENHANCE
- .env.example — OXAGEN_LADDER, OXAGEN_DIFF_BUDGET, OXAGEN_LADDER_MAX_RUNG, OXAGEN_BEST_OF_N_MODE, OXAGEN_REPO_PRIORS flags registered
- git log main — PR #514 (spec + F1 + F6), PR #516 (F2-F10 features), PR #534 (F4b CLI fork mode) all merged to main

**Source documents** (archived verbatim below)

- `docs/specs/swe-rank1-scalpel.md`

## Document — `swe-rank1-scalpel.md`

## Scalpel — SWE-bench Rank-#1 Spec for the Oxagen CLI

**Status:** Draft · **Branch:** `feat/swe-rank1-scalpel` · **Owner:** Mac Anderson
**Goal:** Make the oxagen CLI the highest-scoring agentic coding CLI on SWE-bench-Verified while *simultaneously* minimizing tokens burned, lines of code changed per patch, and wall-clock time per instance.
**Current SOTA to beat:** Lingxi V2.0 — 81.2% pass@1 (MiniMax M2.5 HR). Secondary references: live-SWE-agent / Sonar 79.2%, mini-SWE-agent v2 76.8%.

---

### 0. Design thesis

The four goals (score, tokens, diff size, latency) are **one goal** on SWE-bench-Verified:

1. Gold patches are small. Oversized diffs are both a misdiagnosis signal and the leading cause of hidden `PASS_TO_PASS` breakage. **Minimal diff is a correctness prior, not a style preference.**
2. Token waste is ~80% exploration, and exploration is a symptom of not knowing (a) *where* the bug is and (b) *what "fixed" means*. Fix localization and spec early and cheaply, and steps, diff, latency, and errors all collapse together.

**Prime principle:** *Spend LLM tokens only on decisions. Spend deterministic compute on everything else. Gate every escalation on a measured signal (executed evidence), never on a schedule.*

Failure-mode evidence from our own runs (2026-07-03, 4-task funded sample): heavy code-graph use, plausible-but-wrong patches, 0/4 resolved, ~$13/instance. Diagnosis and spec inference are the binding constraints — not code-writing ability.

#### Architecture at a glance

```
                    ┌────────────────────────────────────────────────┐
 issue text ──────► │ F1 Deterministic Localizer (0 LLM tokens)      │
                    │ F8 Repo Prior injection (~500 tokens)          │
                    └──────────────┬─────────────────────────────────┘
                                   ▼
                    ┌────────────────────────────────────────────────┐
                    │ TRUNK conversation                             │
                    │  F10 Diagnosis artifact → F2 Spec-test (fails) │
                    │  F7 Probes falsify root-cause hypotheses       │
                    └──────────────┬─────────────────────────────────┘
                        F3 ladder  │ signal: spec-test flipped + tests green?
                     ┌─────────────┴───────────────┐
                 YES │                             │ NO / ambiguous
                     ▼                             ▼
             ┌──────────────┐        ┌───────────────────────────────┐
             │ F6 Shrinker  │        │ F4 Cache-forked tails (3–5)   │
             │ then SUBMIT  │        │ one hypothesis each           │
             └──────────────┘        │ F5 consensus-or-escalate      │
                                     └──────────────┬────────────────┘
                                                    ▼
                                          F6 Shrinker → SUBMIT
                                     (F9 filters memory recall throughout)
```

---

### 1. The ten features

Ordered by build sequence (see §2 for why). Each feature lists: motivation, design, touch points, interfaces, tests, acceptance criteria, and expected budget impact. All engine work lives in `packages/agent-engine/src/`; CLI wiring in `apps/cli/src/`.

---

#### F1 — Deterministic zero-token localization

**Motivation.** Localization is currently an agent activity (10–15 steps ≈ 50–150k tokens). The code graph + a traceback parser can produce a ranked candidate-file map *before the first LLM call*.

**Design.**
- New pure module `packages/agent-engine/src/localize/index.ts`:
  - `parseTraceback(text: string): TracebackFrame[]` — Python + Node stack-trace grammars; extracts `(file, line, symbol)` frames, orders by proximity to error origin, filters stdlib/vendor frames.
  - `localize(issue: string, graph: CodeGraphProvider): Promise<LocalizationMap>`:
    1. Traceback path: if frames parse, resolve each frame via `code_graph.search` → seed set; expand one hop with `dependents` + `imports`.
    2. Symbol path: extract backtick-quoted identifiers, CamelCase/snake_case tokens (reuse `extractCandidates` from `evaluate/prompt-enhancer.ts`); resolve via `code_graph.search`/`file_symbols`.
    3. Semantic fallback: `semantic_search` over the issue text when 1–2 yield \< 3 files.
    4. Score fusion: `score = 3·traceback_hit + 2·symbol_hit + 1·semantic_sim + 0.5·dependents_centrality`; return top 5 files with per-file matched symbols and 1-line reasons.
- `LocalizationMap` renders to ≤ 1,000 tokens: `path — symbols — why`, plus "likely test dir" (nearest `tests/` sibling).
- Wire into ENHANCE (`pipeline/index.ts`): runs **before** (and can replace most of) the current LLM-adjacent enhancement; injected as a `## Candidate locations (deterministic)` block. Enhancement budget unchanged (`enhanceTimeoutMs`).
- System prompt line: *"Candidate locations were computed from the code graph. Verify with one read before trusting; do not re-derive them."*

**Interfaces.**
```ts
export interface LocalizationMap {
  files: Array<{ path: string; symbols: string[]; score: number; reason: string }>;
  testHints: string[];        // likely test files/dirs
  tracebackParsed: boolean;
  renderedBlock: string;      // ≤1k tokens, injected verbatim
}
```

**Tests.** `localize/index.test.ts` — traceback fixtures (Django/pytest/sympy formats + Node), symbol extraction, score fusion with a stubbed `CodeGraphProvider`, ≤1k-token render bound, graceful degradation when graph is absent (returns empty map, never throws).

**Acceptance.** On the fixed 10-task subset: gold-patch file appears in top-5 candidates ≥ 7/10; median steps-to-first-edit drops ≥ 30%; zero LLM tokens consumed by the module itself.

**Budget impact.** −50–120k tokens/instance; −1–3 min/instance.

---

#### F2 — Spec-first oracle (failing test before patch)

**Motivation.** Hidden `FAIL_TO_PASS` tests are the real oracle. Our dominant failure is solving the wrong *spec*. Writing "the test the maintainer would add" converts issue prose into an executable spec and yields a free, decisive done-signal.

**Design.**
- Protocol change in the headless system prompt (`prompt/system-prompt.ts` verification protocol): first deliverable is a **spec-test** — a minimal test (or scratch repro script when the harness is heavy) that (a) encodes the issue's expected behavior and (b) **fails on HEAD**. Only then patch, with the goal of flipping it.
- Structural enforcement, not just prompting:
  - New tracker `packages/agent-engine/src/oracle/spec-test.ts`: watches tool traffic for a *repro signal* — a bash run whose command matches `TEST_COMMAND_RE` (reuse from `apps/cli/src/agent/best-of-n.ts`) or a scratch script, with failing exit → later same command passing exit. Exposes `oracleState: 'none' | 'failing' | 'flipped'`.
  - Mid-session judge (`pipeline/index.ts` mid-judge hook) becomes the **spec gate**: at `midJudgeSteps`, if `oracleState === 'none'`, inject a corrective instruction ("no failing repro exists — produce one before further edits") instead of a generic completeness judge. This reuses the existing Phase A/B split; no new pipeline stage.
  - Scratch artifacts live under an ignored path (`.oxagen/scratch/`) and are excluded from the final diff by patch extraction.
- **Fast-path termination (feeds F3):** `oracleState === 'flipped'` + touched-file tests green + diff within budget → skip full JUDGE, submit.
- SWE-bench interaction: `OXAGEN_FORBID_TEST_EDITS` currently blocks test-path writes. Add `OXAGEN_SPEC_TEST_DIR` allowance: spec-tests go to the scratch dir (never shipped), so the guard stays intact for repo test files.

**Tests.** `oracle/spec-test.test.ts` — state machine transitions from synthetic tool-call streams (fail→pass, pass-only, never-run, flaky fail→fail→pass); scratch-path exclusion from diff; mid-judge gate injects corrective prompt when state is `none`.

**Acceptance.** ≥ 8/10 subset runs produce a failing repro before first source edit; wrong-spec patches (patch passes own tests, misses issue intent per manual review) drop vs. baseline.

**Budget impact.** +5–15k tokens up front, repaid by eliminated revise rounds and eliminated final-judge calls on the fast path.

---

#### F3 — Verification-gated adaptive compute ladder

**Motivation.** Uniform pipelines overspend on easy instances and underspend on hard ones. Escalate on **measured** uncertainty only.

**Design.**
- New controller `packages/agent-engine/src/pipeline/ladder.ts` wrapping the existing `runTurn` rounds:
  - **Rung 0 (fast path):** single trunk run (F1 + F2 + F10 injected). Terminal condition: oracle flipped + touched tests green + `diffStats.linesChanged ≤ budget` (default 120, `OXAGEN_DIFF_BUDGET`). On terminal: F6 shrink → submit. **No judge, no revise.**
  - **Rung 1:** oracle flipped but collateral red, or diff over budget → one targeted revise round (existing REVISE machinery) with the specific failing evidence.
  - **Rung 2:** no flip, or judge-disagreement → F4 cache-forked tails with F7 probe-filtered hypotheses.
  - **Rung 3 (cap):** configurable hard stop (`OXAGEN_LADDER_MAX_RUNG`), submit best-effort candidate with highest evidence score.
- Signals struct (all from executed evidence, no LLM): `{ oracle, touchedTestsGreen, diffLines, filesTouched, stepsUsed, loopNudges }`.
- Config: `OXAGEN_LADDER=1` opt-in initially; becomes default for headless/bench profile after A/B.

**Tests.** `pipeline/ladder.test.ts` — pure decision-table tests: every signal combination maps to the expected rung; cap respected; fast path bypasses judge (assert stage events).

**Acceptance.** On subset: ≥ 50% of instances terminate at Rung 0; mean tokens/instance ≤ 60% of baseline at equal-or-better resolve rate.

**Budget impact.** The single largest cost lever: judge+revise (2 extra model calls + a re-execution round) skipped on the majority path.

---

#### F4 — Cache-forked best-of-N (trunk + tails)

**Motivation.** Current `oxagen solve` runs N *complete independent pipelines* in N worktrees — N× re-exploration. Diagnosis is shared work; only the patch is worth diversifying. Fork the *conversation* at the patch point: under Anthropic prompt caching every fork inherits the full investigation at ~10× input discount, launched together inside the 5-min cache TTL.

**Design.**
- Engine support: `runCodingAgent` accepts `initialMessages?: ModelMessage[]` (it already owns `messages[]`; this is a parameter, not a refactor). New `packages/agent-engine/src/fork/index.ts`:
  - `snapshotTrunk(state): TrunkSnapshot` — messages through end-of-diagnosis (delimited by a `DIAGNOSIS_COMPLETE` marker the trunk emits per F10, or heuristically: last message before first source `edit_file`/`write_file`), plus repo state ref (commit of trunk worktree before edits).
  - `forkTails(snapshot, hypotheses: Hypothesis[], opts)` — for each surviving hypothesis (from F7): clone a worktree at the snapshot commit (reuse `best-of-n.ts` worktree machinery), append a divergence message — *"Commit to hypothesis H. Implement the minimal patch for H only."* — and run **bare** engine continuation (no per-tail pipeline). Launch all tails concurrently (existing `pool` machinery) so cache stays warm.
- `apps/cli/src/agent/best-of-n.ts` gains mode `'fork'` (`OXAGEN_BEST_OF_N_MODE=fork|independent`, default `independent` until A/B). Tail count = surviving hypotheses, 2–5.
- Tails reuse `verifyAuto` (union of test commands, re-run per worktree) unchanged.
- Trunk must not edit source before snapshot (F2 scratch repro is allowed — scratch dir is outside the diff); enforce via read-only-source tool wrap on the trunk until snapshot (delete `edit_file`/`write_file` for non-scratch paths — reuse read-only mode plumbing in `tools.ts`).

**Interfaces.**
```ts
export interface Hypothesis { id: string; statement: string; evidence: string; probeResult?: 'survived' | 'falsified' }
export interface TrunkSnapshot { messages: ModelMessage[]; baseCommit: string; oracle: OracleState; localization: LocalizationMap }
```

**Tests.** `fork/index.test.ts` — snapshot boundary detection on synthetic transcripts; tail message assembly (divergence instruction present, hypothesis-specific); worktree-per-tail isolation (stub git); pool concurrency; trunk source-write blocking.

**Acceptance.** Fork mode total tokens ≤ 40% of independent mode at N=3 on the subset, resolve rate ≥ independent mode. Measured cache-read ratio on tails ≥ 60%.

**Budget impact.** Turns best-of-N from ~N× cost into ~1 + N×0.2× cost — makes diversity affordable exactly where the score is decided.

---

#### F5 — Consensus-or-escalate selection

**Motivation.** The comparative selector model call is a per-run tax. Agreement between independently-produced patches is a *free* correctness signal.

**Design.**
- New pure module `packages/agent-engine/src/evaluate/consensus.ts`:
  - `normalizeDiff(diff): NormalizedDiff` — strip index lines/hunk offsets/whitespace-only changes; canonicalize per-file hunks.
  - `diffEquivalent(a, b): boolean` — exact normalized match; `diffClusters(diffs): Cluster[]` — group tails.
- Selection ladder in `best-of-n.ts`/fork mode:
  1. Any cluster of ≥ 2 equivalent passing diffs → pick smallest member, **no selector call**.
  2. Single passing candidate → pick it, no selector call.
  3. Multiple non-equivalent passing candidates → existing `selectBestCandidate` (evidence-weighted), unchanged.
  4. Nothing passing → highest evidence score (oracle state > touched-green > smallest diff), selector only on true tie.

**Tests.** `evaluate/consensus.test.ts` — equivalence under whitespace/offset/ordering noise; non-equivalence on real semantic difference; cluster picking; ladder decision table (selector invoked *only* in cases 3/4-tie — assert via stub call counts).

**Acceptance.** Selector model calls ≤ 40% of fork-mode runs on the subset; zero selection regressions vs. always-judge on the same candidate sets.

**Budget impact.** −1 model call (with N diffs in context — the most token-dense call in the system) on the majority of multi-candidate runs.

---

#### F6 — Deterministic diff shrinker (the ratchet)

**Motivation.** Delta-debug the passing patch to its minimal green subset. Zero LLM tokens, directly buys score (collateral `PASS_TO_PASS` breakage) *and* the fewest-lines goal. No published scaffold ships this as a standing stage.

**Design.**
- New pure module `packages/agent-engine/src/shrink/index.ts`:
  - `parsePatch(diff): Hunk[]`, `renderPatch(hunks): string` — hunk-level model of a unified diff.
  - `shrink(patch, oracle: (candidate: string) => Promise<boolean>, opts): Promise<ShrinkResult>` — greedy reverse delta-debugging: try dropping each hunk (whole-file drops first, then per-hunk), re-run oracle (spec-test + touched-file tests via F2's tracked commands, executed in the candidate worktree with `git apply` of the reduced patch on a clean checkout); keep the minimal green subset. Budget-bounded: `maxOracleRuns` (default 12), skip if `hunks ≤ 2`, always terminate with last-known-green.
  - Safety: never drop hunks the spec-test references (file-path overlap heuristic); result must still flip the oracle, else return original.
- Wire: final step before submit in F3 Rung 0 and after F5 selection. CLI flag `--shrink` on `solve`; `OXAGEN_SHRINK=1` for the bench profile.

**Interfaces.**
```ts
export interface ShrinkResult { patch: string; dropped: number; kept: number; oracleRuns: number; reduced: boolean }
```

**Tests.** `shrink/index.test.ts` — patch parse/render round-trip (fixtures incl. new-file/delete/rename hunks); greedy loop against scripted oracles (independent hunks, dependent pairs, all-required); budget cap; never-worse guarantee (falls back to original when oracle flakes).

**Acceptance.** On synthetic patches with known-superfluous hunks: 100% of removable hunks dropped within budget. On subset: mean submitted-diff lines strictly decreases; no resolve-rate regression.

**Budget impact.** 0 LLM tokens; +30–120 s of test execution on the shrink path only. Expected score gain: fewer hidden-test breakages.

---

#### F7 — Probe-based hypothesis falsification

**Motivation.** The >81.2% frontier is decided by the ~15% where *diagnosis* is wrong. A patch is the most expensive way to test a theory; a probe (assertion/print/two-line scratch script) falsifies one for a few hundred tokens.

**Design.**
- Protocol + light structure, not a new agent:
  - On Rung 2 escalation the trunk is instructed: *"Enumerate 2–3 distinct root-cause hypotheses (different mechanisms, not different phrasings). For each, design the cheapest executable probe that could falsify it. Run the probes. Report survivors as `HYPOTHESIS: <id> SURVIVED|FALSIFIED — <evidence>`."*
  - Parser `packages/agent-engine/src/oracle/hypotheses.ts`: extracts `Hypothesis[]` from trunk output (marker lines), pairs each with its probe command + exit evidence from the tool stream.
  - Survivors feed F4 `forkTails` (one tail per survivor). Zero survivors → the diagnosis is wrong at a deeper level → trunk re-opens localization with the falsification evidence appended (one retry, then Rung 3).
- Probes run in the trunk worktree against unmodified source (scratch scripts, `python -c`, targeted pytest node), so they're free of patch-writing cost.

**Tests.** `oracle/hypotheses.test.ts` — marker parsing (well-formed, malformed, duplicates); pairing with probe evidence; survivor filtering; zero-survivor path.

**Acceptance.** On escalated subset instances: tails-per-instance ≤ survivors (≤3) vs. fixed N=5; qualitative: no two tails implement the same falsified mechanism.

**Budget impact.** A probe ≈ 0.5–2k tokens vs. a full patch attempt ≈ 30–80k. Cuts Rung-2 cost roughly in half while *increasing* diversity quality.

---### F8 — Per-repo procedural priors

**Motivation.** Verified is 500 instances over ~12 repos (django ≈ 45%). Every scaffold pays the "how does this repo work" tax 500 times. Pay it 12 times, ~500 tokens each.

**Design.**
- New store `packages/agent-engine/src/priors/index.ts` — content-addressed JSON at `~/.oxagen/repo-priors/<repo-slug>.json`:
  ```ts
  export interface RepoPrior {
    repo: string;                 // e.g. "django/django"
    testInvocation: string;       // "./tests/runtests.py <label>" etc.
    testDiscovery: string;        // how to find the test for a module
    layout: string[];             // ≤5 bullets: where things live
    conventions: string[];        // ≤5 bullets: patterns that matter
    pitfalls: string[];           // accrued traps ("MAX_NUM_FORMS=0 means unlimited")
    updatedAt: string;
    sourceRuns: number;
  }
  ```
  - `loadPrior(repo)`, `renderPrior(prior)` (≤500 tokens, injected by ENHANCE next to F1's map), `accruePitfalls(repo, lessons)`.
- **Seeding:** first instance of a repo in a run triggers a one-time distillation — a single cheap model call over the trunk trajectory ("extract test invocation, layout, conventions, traps as JSON") — or offline pre-seeding via a script (`scripts/seed-repo-priors.ts`) run once against the 12 Verified repos.
- **Online accrual:** after each resolved instance, pitfall-shaped lessons (existing `gotcha` kind from the memory writer) matching the repo are appended (deduped, capped at 10).
- **Benchmark legality:** priors contain *procedural* knowledge only (how to run tests, layout, conventions, general traps) — never issue-specific solutions, never hidden-test content. Enforced by the distillation prompt + a lint that rejects entries containing issue IDs or diff content. This is standard practice (Lingxi's dev-knowledge is far more aggressive).
- SWE-bench: `OXAGEN_DISABLE_MEMORY=1` stays ON for instance isolation; priors are a separate, explicitly-legal channel controlled by `OXAGEN_REPO_PRIORS=1`.

**Tests.** `priors/index.test.ts` — load/render/accrue round-trip; 500-token render cap; dedupe + cap; legality lint (rejects entries with issue refs/diffs); missing-file graceful path.

**Acceptance.** Instances 2+ per repo skip test-invocation discovery entirely (no failed test-command attempts in trace) on the subset; ~10–30k tokens saved per instance after the first per repo.

---

#### F9 — Memory-recall applicability filter

**Motivation.** Lingxi v1.5's own postmortem: unfiltered retrieved knowledge *biases toward wrong edits*. Our recall (`createCombinedMemory.recallContext`) injects lessons unfiltered today — the same trap.

**Design.**
- New gate in `packages/agent-engine/src/` (engine-side so all surfaces benefit): `memory/applicability.ts` — `filterRecall(items, taskContext, model): Promise<ScoredRecall[]>`:
  - Stage 1 (deterministic, free): drop items with zero lexical/symbol overlap with issue + localization map; cap survivors at 8.
  - Stage 2 (one cheap call, only if >2 survivors): batch-score applicability 0–1 with a one-line reason; keep ≥ 0.6. Uses the flash tier via existing router; skipped entirely under `OXAGEN_DISABLE_MEMORY=1` (bench) — where it matters is real-world usage and F8 pitfall injection, which *is* active on bench.
  - Every injected item is tagged `[recall — verify before trusting]`.
- Wire into ENHANCE where `recallContext()` output is currently injected, and into F8's pitfall render.

**Tests.** `memory/applicability.test.ts` — stage-1 pruning; stage-2 threshold with stubbed model; skip conditions (≤2 survivors, memory disabled); tag presence.

**Acceptance.** Injected-recall volume drops ≥ 50% with zero resolve-rate loss on dogfood tasks; no recalled item without overlap justification appears in prompts.

---

#### F10 — Structured diagnosis artifact (fan-out on demand)

**Motivation.** EVALUATE defaults to a non-LLM heuristic; issue-understanding never produces a first-class artifact. A structured diagnosis is (a) the trunk's plan, (b) F4's fork point marker, (c) F7's hypothesis source.

**Design.**
- Schema `packages/agent-engine/src/evaluate/diagnosis.ts`:
  ```ts
  export interface Diagnosis {
    problem: string;              // one-paragraph restatement
    expectedBehavior: string;     // what "fixed" means, testably
    rootCauseHypotheses: Hypothesis[];   // 1–3, distinct mechanisms
    blastRadius: string[];        // files/systems a fix may touch
    diffBudget: number;           // self-estimated lines (informs F3 budget)
  }
  ```
- **Default (cheap):** the trunk itself emits `DIAGNOSIS_COMPLETE` + a fenced JSON diagnosis after F1/F2 evidence gathering — enforced by system-prompt protocol + parser with one reprompt retry. Zero extra model calls.
- **Fan-out (Rung 2+ only):** 2 parallel flash-tier analyses over (issue + localization map + trunk evidence digest), merged by rule (union hypotheses, dedupe by mechanism; disagreement on expectedBehavior → flag for probe). Reuses `judgePanel`'s parallel-call pattern.
- Consumers: F3 reads `diffBudget`; F4 snapshots at the marker; F7 takes `rootCauseHypotheses`.

**Tests.** `evaluate/diagnosis.test.ts` — JSON extraction from noisy transcripts (fenced, malformed, missing → reprompt path); merge rules; hypothesis dedupe-by-mechanism.

**Acceptance.** ≥ 9/10 subset trunks emit a parseable diagnosis on first try; fork-point detection uses the marker (not the heuristic fallback) in ≥ 8/10 fork-mode runs.

---

### 2. Optimized build plan

**Optimization criteria:** evidence-per-effort first (prove value on the fixed 10-task subset before building dependents), dependency order second, dogfood-ability third (early features are pure modules — ideal one-shot targets for the oxagen CLI building itself).

#### Dependency graph

```
F1 ──────────► F2 ───► F3 ───► F4 ───► F5
 │              │       ▲       ▲
 └► F8 (render) └► F6 ──┘       │
                        F10 ────┼───► F7
                        F9 (independent)
```

#### Phases

| Phase | Features | Why this order | Verification gate |
|---|---|---|---|
| **A** | **F6 shrinker, F1 localizer** | Pure deterministic modules, zero LLM cost, no pipeline coupling, highest evidence-to-effort. Perfect first dogfood targets. | Unit tests green (narrow vitest, new files only) + F1 top-5 hit-rate on subset traces |
| **B** | **F2 spec-first, F3 ladder** | The control loop. F2 gives the oracle signal; F3 consumes it. Together they create the cheap fast path everything else assumes. | Subset A/B vs. baseline: tokens ≤ 60%, resolve ≥ baseline |
| **C** | **F10 diagnosis, F4 fork, F5 consensus** | The candidate machinery, strictly dependent on B's signals and F10's marker. F5 is trivial once F4 exists. | Fork-mode vs. independent-mode A/B at N=3 on subset |
| **D** | **F7 probes, F8 priors, F9 memory filter** | Hard-tail quality + amortization. F7 needs C; F8/F9 are independent but lowest-risk-of-regression last. | Escalated-instance cost halves; per-repo token drop measured |

**Rules for every phase** (binding, from CLAUDE.md):
- Work happens in this worktree (`~/Workspaces/oxagen-swe-rank1`, branch `feat/swe-rank1-scalpel`), committed + pushed at every feature boundary; draft PR stays current.
- **Never run whole-repo suites.** Verify with the narrowest command only: `pnpm --filter @oxagen/agent-engine test:unit -- <new-file>.test.ts`. CI is the authoritative gate.
- Every feature lands functionally complete: module + wiring + unit tests + env-flag registration (`.env.example`) + a `docs/capabilities/` note if a contract surface changes (none expected — this is all engine/CLI internal).
- New behaviors ship behind env flags, default-off, flipped on for the bench profile only after their subset A/B wins. **The baseline must never get worse mid-build.**
- Full `pnpm gate` + test-completeness-judge once per phase (pre-merge checkpoint), not per commit.

#### Dogfooding protocol (build oxagen with oxagen)

Each feature is implemented by the installed CLI (`oxagen` v0.10.0) in one-shot mode from the worktree root:

```bash
cd ~/Workspaces/oxagen-swe-rank1
oxagen --mode accept-edits --max-steps 120 --output-format json "<feature brief>"
```

- **Feature briefs** are extracted from this spec (§1 sections are written to be self-contained briefs: design, interfaces, tests, acceptance).
- Every brief restates: *"Do NOT run any repo-wide test suite. Verify only with `pnpm --filter @oxagen/agent-engine test:unit -- <your new test file>`."*
- After each CLI run: human/driver session reviews the diff, runs the narrow test itself, commits with a `dogfood:` trailer noting tokens/steps from the JSON envelope, pushes.
- CLI run telemetry (tokens, steps, duration from `--verbose`/JSON envelope) is recorded in `verifications/<session>/dogfood-<feature>.json` — this doubles as baseline data for measuring the very features being built.
- Fallback: if a one-shot stalls or exceeds budget, the driver session finishes the feature directly (the spec is the contract either way) and files the failure as a data point.

#### Measurement harness

- **Subset:** the fixed 10-task SWE-bench-Verified subset (existing bench worktree tooling; `bench/swe-bench/{run,compare}.sh`).
- **Metrics per run:** resolve rate, total tokens (cache-read vs. fresh split), wall-clock/instance, submitted-diff lines, model calls by role (executor/judge/selector), rung distribution.
- **Ratchet:** a config only graduates to bench-profile default when its A/B shows non-inferior resolve at lower cost, or higher resolve at ≤ 1.2× cost.
- **Exit criterion for the whole spec:** full-500 Verified run at ≥ 82% pass@1 with ≤ $3 mean cost/instance and mean submitted diff ≤ 1.5× gold-patch size.

#### Risks & mitigations

| Risk | Mitigation |
|---|---|
| Spec-test anchors on wrong spec for ambiguous issues | Spec-test is falsifiable: contradicting probe evidence reopens it (F7); mid-judge can demand a revised spec-test |
| Cache TTL (5 min) missed between trunk snapshot and tail launch | Tails launch immediately and concurrently at snapshot; F4 acceptance measures cache-read ratio |
| Shrinker oracle flake drops a needed hunk | Never-worse guarantee: reduced patch must re-flip oracle or original is submitted |
| Fork-mode trunk contaminated by early edits | Source-write tool block until snapshot (structural, not prompted) |
| Priors leak issue-specific knowledge (bench legality) | Procedural-only lint + distillation prompt constraint; priors channel separately flagged |
| Flag sprawl / config drift | All flags registered in `.env.example` + one `ladder-config.ts` resolver with tests |

---

### 3. Non-goals

- No new pipeline *stages* beyond the ladder controller — every feature reuses existing hooks (ENHANCE, mid-judge, best-of-N, selector).
- No Lingxi-style separate role-agents with inter-agent chat; roles stay stateless calls or forks of one conversation.
- No trajectory-abstraction trees (Lingxi V2.0's mechanism) in this spec — F8's procedural priors capture the cheap 80%; revisit only if the exit criterion stalls.
- No changes to platform API/MCP surfaces; this is engine + CLI internal (no capability-parity work triggered).

