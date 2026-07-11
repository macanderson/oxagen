# Bench #1 Prompt Playbook

**Date:** July 10, 2026
**Companion to:** `bench-1-roadmap-2026-07-10.md` (validated research + roadmap) and `agentic-cli-moonshots-2026-07-10.md` (source ideas)
**Goal:** defensibly #1 on Terminal-Bench 2.1 and SWE-rebench, with auditable receipts.

## How to use this playbook

- One prompt = one fresh Claude Code session = one branch and PR. Paste the prompt verbatim; CLAUDE.md handles branching, testing, and PR discipline automatically.
- **Sequence matters between stages. Prompts marked ∥ within a stage can run in parallel sessions.**
- Do not skip Stage 0. P0 prevents rebuilding things that already exist; P1 creates the yardstick every later prompt is measured against.
- Stage 2's P10 is a loop: repeat it until the scoreboard says #1. Everything after Stage 2 defends and monetizes the position.

---

## Stage 0 · Foundations (sequential)

### P0 — Baseline audit (do this first, prevents duplicate work)

> Read docs/ideas/bench-1-roadmap-2026-07-10.md fully. Then audit what already exists in this repo versus that roadmap and produce docs/ideas/bench-1-gap-report.md. Specifically verify the current state of: the ADR-028 / PR #905 shadow-revert witness gate in runTurn (does it run on every fix+test turn, on which surfaces, and is it enforced in the app engine path or only CLI, see the cli-app-engine-parity-gap note), fleet fan-out and agent.subagent.dispatch, per-turn USD budgets (PR #625), envelope-v1 event log coverage (ADR-023, does it capture full tool I/O), evals-v1 (PR #569), the SWE-bench harness under tools/ or bench/ (PR #671 hardening), bi-temporal fact edges (PR #563), and the semantic AI cache (PR #560). For each: works today / partial / missing, with file:line evidence. No code changes. End with a revised build-vs-extend recommendation for prompts P3 through P7 of the playbook.

### P1 — The scoreboard (the yardstick everything else is measured by)

> Build our internal benchmark scoreboard. Create a bench runner (new package or tools/bench) that evaluates the Oxagen CLI agent against Terminal-Bench 2.1 via the harbor framework using the official protocol: 5 trials per task, default task environments, no overrides to timeouts, CPU, memory, or storage, and preserved job directories per run (the maintainers require these for submission validation). Add a SWE-rebench-style local mode using their public task dumps with pass@5 and standard error reporting. Hard requirements: sandbox egress disabled during runs (log and assert no network), fleet memory disabled, per-task cost tracking written to ClickHouse, results and job dirs archived under a versioned directory with the harness git SHA. Establish and record our current baseline score with the existing harness before any other playbook PR merges. Document how to re-run in the package README.

### P2 — The shared verifier contract

> Design and implement the shared executed-test verifier that tournament selection, the mutation gate, and (later) the outcome router will all consume. Read docs/ideas/bench-1-roadmap-2026-07-10.md (ideas 5, 6, and 10) and the P0 gap report first. Deliver: a capability contract (verify.outcome or similar per ADR-025 naming) that takes a candidate patch + test set + sandbox ref and returns a structured verdict (fail-to-pass result, pass-to-pass result, executed-test evidence, timing, cost), implemented as one handler that wraps sandbox execution, with the ADR-028 shadow-revert witness as one check inside it rather than a parallel code path. Full capability parity per CLAUDE.md. This contract is the ground truth the roadmap sells; design it so a third party could read a verdict object and audit the run.

---

## Stage 1 · The verified core (all four ∥ after P2 merges)

### P3 ∥ — Mutation gate: extend, don't rebuild

> Read ADR-028 and the PR #905 implementation of the shadow-revert witness gate, plus the P0 gap report. Extend it in three ways: (1) enforce it uniformly across surfaces, including the app engine path (see the cli-app-engine-parity-gap note: app runs bare runCodingAgent while CLI runs the runTurn pipeline; the gate must not be CLI-only); (2) route it through the P2 verifier contract so its verdicts are structured and auditable; (3) add Layer 2: LLM-guided mutation testing scoped to the changed region only (generate mutants of the patch, measure the kill rate of the agent's tests, record the score in the verdict). Emit gate outcomes to ClickHouse so we can measure vacuous-test catch rate. Do not weaken the gate to make tests pass; a fix+test turn whose test passes with the fix reverted must be rejected.

### P4 ∥ — Verified edits

> Implement verified edits per docs/ideas/bench-1-roadmap-2026-07-10.md idea 4. Three pieces: (1) content-hash anchoring for the agent edit tools (hashline-style: each edit references a hash of the target region; on mismatch the tool forces a re-read instead of applying a misplaced patch); (2) the typecheck-delta gate: snapshot compiler/typecheck diagnostics before and after each edit, auto-reject an edit that introduces new diagnostics unless the agent explicitly declared a will-break-until-step-N intent in the tool call; (3) a per-edit lineage record (anchor hash, diagnostic delta, producing turn id) written to the lineage graph. Wire into both the CLI runTurn pipeline and the app engine path. Add an escape-hatch config for the declared-break flow and tests proving a torn patch and a diagnostic regression both get rejected. Measure edit-application failure rate before/after in ClickHouse.

### P5 ∥ — Tournament mode

> Productize tournament mode per docs/ideas/bench-1-roadmap-2026-07-10.md idea 5. On turns the triage model marks risky, silently fork N rollouts across isolated sandboxes/worktrees using the existing fleet fan-out and agent.subagent.dispatch lineage, optionally across model families via modelIdOf tiers. The winner is selected by the P2 executed-test verifier contract, never by an LLM judge. N is derived from the per-turn USD budget (PR #625): document the mapping (e.g. default 1, +$2 buys 5-way). The user sees only the winning diff; losing rollouts are preserved in the lineage graph with their verdicts for audit. Full capability parity (contract, API, MCP, CLI, app). Include a config to force tournament-on for benchmark runs, and emit per-rollout cost and verdict to ClickHouse. Add the attempts-declaration metadata needed for Best@k disclosure.

### P6 ∥ — Trajectory receipts (recording pulled forward from idea 7)

> Build the trajectory receipts pipeline: the recording half of docs/ideas/bench-1-roadmap-2026-07-10.md idea 7, pulled into Phase 1 because the #1 claim requires it. Extend envelope-v1 (ADR-023) so a completed run can be exported as a self-contained, publishable bundle: full ordered tool I/O, model/harness/config versions, per-edit lineage records (P4), verifier verdicts (P2/P3), sandbox filesystem snapshot manifest, and cost accounting. Add an export command (CLI + contract parity) that produces the bundle plus a human-readable HTML index. A stranger with the bundle must be able to audit what the agent did turn by turn; bit-for-bit re-execution ships later, but the record format must already contain everything replay will need. Redaction pass for secrets before export is mandatory.

### P7 ∥ — Bench integrity mode

> Implement bench integrity mode as a single configuration profile used by the P1 scoreboard: (1) sandbox egress hard-disabled with an assertion that fails the run if any network call escapes; (2) fleet memory and fact-graph recall disabled, or restricted to facts whose grounding commit predates the task (temporal restriction), controlled by config and recorded in the run manifest; (3) the harness optimizer hold-out policy: benchmark tasks and their traces are excluded from every evals-v1 dataset and from any future optimizer training set, enforced by a tag filter with a test; (4) a disclosure manifest generator that emits, per run: model ids, harness git SHA, attempts N, selector description, cost per task, memory policy, and egress policy. This manifest ships with every leaderboard submission and every public claim.

---

## Stage 2 · Measure, harden, submit (sequential, P10 loops)

### P8 — The ablation matrix

> Using the P1 scoreboard in bench integrity mode (P7), run the ablation matrix on Terminal-Bench 2.1 tasks: baseline harness; +mutation gate (P3); +verified edits (P4); +tournament at N=3 and N=5 with executed-test selection (P5); and tournament with an LLM-judge selector instead (same N) as the comparison arm. 5 trials per configuration per the official protocol. Produce docs/ideas/bench-1-ablation-report.md with per-lever point contributions, cost per task per configuration, variance across trials, and the execution-vs-judge delta. This is both our tuning data and the publishable result the research pass found missing from the literature. Do not cherry-pick: report every configuration run.

### P9 — Reward-hacking self-audit

> Build the transcript self-audit that we run before any leaderboard submission. Given a set of run bundles (P6), audit every trajectory for the hack classes Cursor documented plus ours: solution retrieval (any network egress, any suspiciously verbatim patch), test tampering (edits to test files that weaken assertions), gate evasion (attempts to modify verifier or logging code, the Darwin Godel Machine failure mode), and memorization signals (correct patches produced with implausibly little exploration). Output a scored report per run and a summary suitable for publishing alongside a submission. Run it against our latest P8 bundles and fix anything it finds before proceeding.

### P10 — The climb loop (repeat until #1)

> Pull the latest scoreboard results and job directories from the P1 bench runs. Analyze the failed tasks: cluster failures by cause (localization, edit application, vacuous verification, timeout, tool error, planning), read the worst 10 trajectories in full, and identify the top 3 harness defects behind the largest failure clusters. Fix all three at root cause, with tests. Re-run the affected benchmark subset first, then a full 5-trial scoreboard run in bench integrity mode, and append the before/after scores, cost per task, and variance to docs/ideas/bench-1-climb-log.md. Constraints: never train on or special-case specific benchmark tasks; fixes must be general harness improvements; the optimizer hold-out (P7) stays intact. Report the new score and the next three candidate defects.

*(Repeat P10 in fresh sessions until the scoreboard beats the published #1 on Terminal-Bench 2.1 with margin exceeding our cross-trial variance. Between iterations, escalate N via P5's budget mapping only if the P8 data says tournament width, not harness defects, is the binding constraint.)*

### P11 — Submission and the claims page

> We are ready to submit. (1) Assemble the Terminal-Bench 2.1 submission: 5-trial results, job directories, and the P7 disclosure manifest, following the current process at tbench.ai (their docs say a new submission process is coming; check and follow the live instructions, and email results with job dirs if that is still the channel). (2) Prepare the SWE-rebench evaluation request per swe-rebench.com (they run models themselves 5x and report pass@5 with standard error; give them exactly what they need to run our agent). (3) Publish run bundles (P6) for every submitted trajectory, post-redaction, with the P9 audit report. (4) Build the public claims page: dated, scoped claims only ("#1 on Terminal-Bench 2.1 as of DATE, harness SHA, model, attempts, median cost/task"), auto-updated from scoreboard data, with a standing rule that a displaced present-tense claim comes down automatically while dated claims persist. Route copy through the brand voice guidelines: no hype, numbers attached, no em-dashes.

### P12 — Publish the method

> Write the external ablation writeup from docs/ideas/bench-1-ablation-report.md: execution-grounded versus LLM-judge selection at agentic scale, plus per-gate contributions (mutation gate, verified edits, tournament width). Structure: motivation (the CMU verification gap, arXiv:2602.18998), method, results, costs, threats to validity, and the receipts (linked replayable run bundles). Target: a technical blog post in apps/docs plus an arXiv-ready draft. Every number must trace to an archived scoreboard run. This is the credibility layer of the #1 claim: the score has a method, the method has receipts.

---

## Stage 3 · The learning loop (defend the position; ∥ where marked)

### P13 — Full replay and auto-distillation

> Complete idea 7 from docs/ideas/bench-1-roadmap-2026-07-10.md on top of the P6 record format: deterministic bit-for-bit re-execution of any recorded run (recorded tool I/O replayed, sandbox FS restored from snapshots), step bisection to find the turn where a run went wrong, resume-from-step under a different model, prompt, or harness version, and automatic distillation of every failed or thumbs-downed production run into an evals-v1 case within 24 hours (excluding benchmark-tagged runs per the P7 hold-out). Verify by replaying five archived bench runs and getting identical verdicts.

### P14 — Harness evolution (after P13)

> Build the nightly harness optimizer per idea 2 of docs/ideas/bench-1-roadmap-2026-07-10.md, with the reward-hacking safeguards as hard requirements: the optimizer mines ClickHouse traces for failure motifs, proposes harness patches (prompt tweaks, tool-doc rewrites, routing thresholds, deterministic fast-paths), validates candidates against evals-v1 datasets built by P13, and ships winners behind flags. Non-negotiables: the eval harness and its datasets are immutable to the optimizer (separate write path, enforced by permission and by test); every autonomously shipped patch has a human-readable diff and a rollback flag; benchmark hold-out (P7) is enforced at the dataset layer. First target: the failure clusters the P10 climb log left unresolved.

### P15 ∥ — The learning fact graph

> Implement idea 1 from docs/ideas/bench-1-roadmap-2026-07-10.md: verified mid-session discoveries written back to the knowledge graph as bi-temporal fact edges (build on PR #563), cited to the grounding code (file, symbol, commit), closed (not deleted) when a git diff touches the grounding code, shared fleet-wide per workspace, and queryable as-of-commit through the ontology contracts. Recall must respect the temporal-restriction flag from P7. Only facts that passed a verifier (P2 verdicts, executed commands, or confirmed observations) may be written; model speculation may not. Measure: token spend and localization accuracy on repeat-repo sessions, before versus after, in ClickHouse.

### P16 ∥ — Trace-first debugging (narrow scope)

> Implement the two-phase debugging workflow from idea 8 of docs/ideas/bench-1-roadmap-2026-07-10.md, and only that workflow: on a failing test, run it once under a coverage/call tracer inside the sandbox, feed the executed path into context as structured evidence, then expose breakpoint/inspect tools targeted at the divergence point. Do not build a general DAP tool surface (commoditized; JetBrains ships it). Contract-shaped, metered, and recorded in run bundles like every other tool. Measure on the debugging-heavy cluster from the P10 failure taxonomy.

### P17 ∥ — Macro mining (discovery only)

> Start idea 9 from docs/ideas/bench-1-roadmap-2026-07-10.md, mining only: cluster successful production traces in ClickHouse by semantic task signature (embed the goal plus the tool-sequence shape; do not cluster on raw action vectors, the literature shows that fails), and produce a weekly report of recurring workflow clusters with frequency, mean cost, and a proposed parameterized macro skeleton per cluster. Human-reviewed; no execution path yet. This feeds P18.

---

## Stage 4 · The economic moat (∥ after their dependencies)

### P18 — Trace macros ship (after P17 + P2)

> Compile the top human-approved macro clusters from P17 into parameterized deterministic macros: replayable tool sequences with typed holes, validated by the P2 executed-test verifier before admission to the macro library, and replayed at machine speed with the LLM filling holes and reviewing the result. Version macros, expire them when their grounding code changes (reuse P15 expiry machinery), and record macro replays in run bundles. Measure: latency and cost on matched task signatures versus the full agent loop.

### P19 — The verified-outcome router (after P8 data + volume)

> Build the learned router from idea 10 of docs/ideas/bench-1-roadmap-2026-07-10.md: per task-signature class, compute live cost/accuracy Pareto curves from ClickHouse history of P2 verifier verdicts per model at current AI Gateway prices, route each subtask to the cheapest model clearing the class's verified-success threshold, escalate on verifier rejection, and re-fit as prices and models drift. Ship behind a flag with the existing per-function routing as fallback. Dashboard the Pareto curves in the app (capability parity applies).

### P20 — The accuracy SLA (after P19 has production data)

> Design and implement the refund-backed accuracy SLA: for selected test-verifiable task classes with sufficient P19 volume, offer "at least X% verified success at up to $Y per task, or credits auto-refund," with X and Y derived from the Pareto data with margin. Enforcement rides the existing metering-to-Stripe loop: verifier verdicts (P2) are the settlement record, refunds issue automatically from failed-verdict aggregates, and every settlement links to auditable run bundles. Legal review checklist and clear class boundaries in the product copy. This is the endgame claim: accuracy with a price tag, enforced by the same pipe that bills.

### P21 ∥ — Speculative execution (anytime in Stage 4)

> Implement idea 3 from docs/ideas/bench-1-roadmap-2026-07-10.md as a latency feature: a small local draft model (existing ONNX/Ollama path) predicts the next 1-3 tool calls during frontier-model generation and executes them speculatively into a result cache; matches serve instantly, mispredictions are discarded. Hard policy, enforced by contract: speculation only for read-only, sandbox-local operations; never network calls, never mutations, never billable externals (a discarded branch must not bill or leak intent). Also add sandbox pre-warm and prompt-file prefetch. Measure perceived-latency delta on read-heavy turns and prediction hit rate.

---

## Standing rules across every prompt

1. Benchmark tasks and traces never enter training or optimizer datasets (P7 hold-out). If a prompt's work would touch them, stop and flag it.
2. Every gate (P3, P4) fails closed. Never weaken a gate to green a test.
3. Every public number traces to an archived, replayable run.
4. Claims are dated and scoped; displaced claims come down; the receipts claim ("the only entry you can replay") is the durable one.
5. One prompt, one session, one PR. Re-read the gap report (P0) before extending anything.
