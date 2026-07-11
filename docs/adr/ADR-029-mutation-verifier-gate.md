# ADR-029: The mutation verifier gate — every green turn must prove its tests witness the fix

- **Status:** Accepted
- **Date:** 2026-07-10
- **Owners:** agent-engine
- **Related:** ADR-021 (inference doctrine — deterministic-before-model),
  ADR-017 (unified agent engine), `docs/VISION.md` (verified outcome as a link
  in the accountability chain)

## Context

The most embarrassing failure class in agentic coding is the **confidently
shipped no-op fix**: the agent edits source, writes (or tweaks) a test, runs
it, sees green, and declares victory — but the test would have passed without
the fix. The green witnessed nothing. Judges (LLM completeness checkers)
routinely miss this because the executed evidence *looks* decisive: tests ran,
tests passed.

The engine already had the two halves of a solution without connecting them:

- The **spec-test oracle** (`oracle/spec-test.ts`) watches bash traffic and
  records which test-like command flipped fail→pass during the turn — the
  agent's own claimed witness.
- The turn's **final diff** (`workspace.diff()`) is a faithful record of every
  change the fix made.

## Decision

After the judge calls a round complete, a **deterministic mutation gate** runs
inside `runTurn` (`pipeline/index.ts`), ON by default:

1. Parse the turn diff; partition into test files (`isTestPath`) and source
   files.
2. Only proceed when the turn made a **witness claim**: the oracle flipped, or
   test files changed. (Rejecting a turn that never claimed test evidence
   would punish honesty.)
3. **Revert the fix in a shadow**: reverse-apply the source-file segments
   (test files stay in place — their current content *is* the claim), by
   reconstructing pre-fix contents from the diff. Everything runs through the
   `Workspace` port; nothing touches raw fs.
4. Re-run the agent's own passing test-like commands (flip first, capped at
   3, bounded by a per-command timeout) and **demand a failure**.
5. Restore the snapshots — always, in a `finally`; a failed restore throws
   loudly rather than leaving a silently corrupted tree.
6. Verdicts:
   - **witnessed** — at least one witness run failed without the fix. The
     green is real; the verdict stands.
   - **vacuous** — everything still passed. `applyGateToVerdict` overrides the
     judge's `complete` and the EXISTING revise loop sends the agent back with
     an explicit instruction to produce a test that fails without the fix.
   - **skipped** — anything the gate could not do faithfully (rename/binary/
     quoted-path/no-trailing-newline segments, diverged working tree, no
     witness command). Fail-open, with the reason recorded.

**Layer 2 (opt-in `mutationScore` / `OXAGEN_MUTATION_SCORE=1`):** when the
witness check passes, deterministic one-line mutants (`===`→`!==`, `&&`→`||`,
boundary flips, boolean flips, early return) are applied to the lines the fix
added, and the witness command's kill rate is recorded on the trace — a
measure of how tightly the tests constrain the patch, not just whether they
witness it.

Every gate verdict is persisted on `TurnTrace.mutationGates` and surfaced live
via `judge` stage events. Kill switches: `OXAGEN_MUTATION_VERIFY=0` (env) or
`mutationVerify: false` (option; wins over env). Timeout knob:
`OXAGEN_MUTATION_TIMEOUT_MS`.

## Consequences

- A green turn that survives the gate carries **executed proof** that its
  tests witness its fix — one more verified link in the accountability chain
  (identity → scope → action → **verified outcome** → audit record).
- Cost: one extra run of an already-run test command per green coding turn
  (layer 1); layer 2 costs one run per mutant, which is why it is opt-in.
- The gate is deterministic and model-free, per ADR-021: never spend a model
  where executed evidence settles the question.
- Known V1 limits (deliberate): unsupported diff shapes skip rather than
  guess; the shadow is the live working tree with guaranteed restore rather
  than an FS-snapshot sandbox; mutants are deterministic operators, not
  LLM-guided. Each is an explicit extension seam.
