# Oxagen Rust CLI — Benchmark Strategy ("#1 by >3pp" claim)

This document defines exactly what we will measure, how, and the rules that
keep the claim honest — reusing and tightening the fairness discipline
already established in `bench/swe-bench/README.md` ("Fairness &
methodology").

## 1. The claim, precisely

> "`oxagen-cli` resolves ≥3.0 percentage points more of SWE-bench Verified
> than the best publicly documented comparable agent, at the same pinned
> worker model, measured by the official Harbor/SWE-bench verifier — not
> self-graded."

Two things this claim is **not**:

- It is **not** "oxagen's base model is better" — it is a scaffold-quality
  claim at a fixed model, exactly the distinction `bench/swe-bench/README.md`
  already draws for the existing TS harness.
- It is **not** a claim against every number on the public leaderboard
  (`swebench.com`) indiscriminately — leaderboard entries use different
  models, prompts, task subsets, and retry budgets. We compare against the
  **best entry we can run ourselves** under controlled, identical conditions
  (`compare.sh`-style), and separately cite the public leaderboard rank only
  with explicit labeling of which number is which — never merged in one
  table without that label.

## 2. Comparison target selection

At the time of the Phase 5 run, pick the comparison target as:

1. The highest-resolve-rate agent we can install and run ourselves through
   Harbor (Claude Code, Codex CLI, Aider, OpenHands, Gemini CLI, SWE-agent —
   whatever Harbor supports natively at that time, per `compare.sh`'s
   `COMPETITORS` list), on the **same pinned model** as oxagen-cli's run.
2. If the single best public leaderboard number (`swebench.com`) at a
   comparable model class is *higher* than what we can reproduce locally
   with any Harbor-supported agent, we do not simply claim victory over the
   local number and ignore the leaderboard — we either (a) attempt to
   reproduce that leaderboard entry's public harness ourselves if one
   exists, or (b) explicitly caveat the published claim as "vs. the best
   locally-reproducible comparison; leaderboard entry X reports Y% under
   different conditions (model/harness/subset), see methodology." Never
   silently drop an inconvenient number.
3. The >3pp margin must hold against **both** the best locally-reproduced
   competitor run and, where directly comparable (same model, same full
   Verified set, no undisclosed retry budget), the best leaderboard entry.

## 3. Fixed variables (controlled comparison)

Per run, hold constant across oxagen-cli and every competitor:

- **Dataset**: `swe-bench/swe-bench-verified` (official 500-instance set),
  full set for the headline claim — not Lite, not a subsample (subsample
  results may be published as directional/early signal but never as the
  headline number).
- **Worker model**: one pinned model id, passed via each agent's native
  model-pin flag (mirrors `OXAGEN_MODEL_SLUG` passed to `-m` in the existing
  `compare.sh`). Run the claim at more than one model tier if resources
  allow (e.g. a mid-tier and a frontier-tier model) to show the margin is
  not an artifact of one model's quirks.
- **Verifier**: the official Harbor/SWE-bench verifier only — the agent
  never sees or influences the verifier, exactly as today's harness
  guarantees (`bench/swe-bench/README.md` §"What this measures").
- **Attempts per instance**: `N_ATTEMPTS=1` for the headline single-shot
  number; best-of-N numbers are reported as a clearly separate row
  (`--candidates N`), never blended into the single-shot claim.
- **Concurrency / hardware**: same container class, same `N_CONCURRENT`,
  documented in the published methodology (wall-clock comparisons are
  secondary to resolve-rate but must also be reported honestly per instance
  where feasible).

## 4. What's allowed to differ (and must be disclosed)

- Prompt engineering, tool design, context-engineering (code-graph),
  retry/compaction policy, best-of-N selection strategy — this is the
  scaffold being benchmarked; it's expected to differ and is the entire
  point.
- Provider routing mechanics (oxagen-cli talks directly to the provider;
  competitors may route through their own gateway) — disclosed, not hidden,
  and does not affect the verifier's pass/fail decision.

## 5. Levers to earn the margin (ranked by expected impact)

1. **Best-of-N with evidence-based selection** (`oxagen-pipeline`, Phase 3):
   N independent trajectories, selected by agent-authored repro-test
   outcome + existing targeted-test signal + a diff-level judge panel.
   Historically the single biggest lever for resolve-rate at fixed cost per
   the existing TS spec's own framing (`docs/specs/cli-swe-bench/02-spec.md`
   §5) — the Rust port inherits this design and should tune N against a
   cost/resolve-rate curve, not just maximize N blindly.
2. **Context compaction that never wedges** (`oxagen-core`, Phase 2): a
   context-overflow failure is a scaffold bug, not a hard task — every
   instance lost to `context_length_exceeded` is a free percentage point on
   the table. Zero-tolerance target: 0 instances fail purely from context
   overflow in the final run.
3. **Retry/backoff on transient provider errors**: same logic — a 429 or
   transient 5xx killing a turn is a scaffold failure, not a model failure.
   Target: 0 instances fail purely from an unretried transient error.
4. **Code-graph-informed context** (`oxagen-graph`, Phase 3): graph-first
   navigation over blind grep on unfamiliar repos, including the
   Python-import-edge fix noted as a known TS gap — likely the second-
   biggest lever after best-of-N on repos the model hasn't memorized.
5. **Tool precision** (`oxagen-tools`, Phase 1): fuzzy-match edit-failure
   feedback, ripgrep-backed search with correct `.gitignore`/Python-ignore
   handling, middle-out truncation that preserves failing-test tails — each
   individually small, cumulatively meaningful across 500 instances.
6. **Loop detection + malformed-call repair**: prevents a small number of
   instances from silently burning their entire step budget on a repeating
   failure with zero forward progress.

## 6. Anti-p-hacking rules (binding)

1. **No test-set leakage.** Never let the agent or any tuning loop see
   `FAIL_TO_PASS`/`PASS_TO_PASS` test names or SWE-bench metadata beyond
   what the official harness exposes to any agent (the issue text + repo
   state). Tuning best-of-N selection heuristics against the *verifier's own
   pass/fail signal* on a held-out dev subset, not the Verified set itself,
   before the final headline run.
2. **Pre-register the run.** Before executing the full-set headline run,
   commit (to the branch/PR, publicly once open-sourced) the exact config:
   model id, `N_ATTEMPTS`, `--candidates` value, prompt profile, code-graph
   on/off, pipeline on/off. No post-hoc cherry-picking of the best of several
   full-set runs — if a full run under-performs, iterate on the *scaffold*
   (with a fresh dev-subset validation), then re-run the full set again with
   a new pre-registered config, and report all runs' configs if more than
   one full-set run is published.
3. **Publish raw trajectories** for the headline run (`bench/web`'s
   `oxagen.eval.v1` schema already supports this) so a third party can audit
   individual instance outcomes, not just the aggregate percentage.
4. **Re-run competitors under the same conditions**, not cite their own
   self-reported numbers, wherever a Harbor adapter for them exists — this
   is what `compare.sh` already guarantees for the TS harness and must
   carry over unchanged for the Rust harness.
5. **Refresh cadence.** Competitors ship new agents/scaffolds too. Re-run
   the comparison at least quarterly (or whenever a competitor publicly
   claims a new SWE-bench Verified state-of-the-art) and update the public
   claim — a stale ">3pp as of six months ago" claim left unrefreshed is a
   credibility risk, not a badge.

## 7. Reporting format

Every published number carries, inline, not in a footnote:

- Dataset + subset size (e.g. "500/500 SWE-bench Verified").
- Pinned model id.
- Attempts per instance (1 for single-shot; N for best-of-N, labeled).
- Harness + verifier (Harbor + official SWE-bench verifier).
- Date of run + git SHA of the oxagen-cli build used.
- Link to raw trajectories.

Table format mirrors `bench/web`'s existing dashboard conventions — reuse
that infrastructure rather than building a second one.
