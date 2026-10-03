# ADR-286: The Phase 1 pilot is measured from the work records, and a person decides it

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** work
- **Related:** issue #5241 (lane P1-06), #5243 (the deployed gates),
  #5244 (reverts), `agent-work-phase-1.html` in `oxageninc/roadmap`
  (Release gates), ADR-244, ADR-251, ADR-255,
  `docs/specs/work/release-gates.md`,
  `packages/handlers/src/lib/work-release/release-gates.pg.test.ts`,
  `packages/handlers/src/lib/work-read/outcomes.ts`.

## Context

The phase document sets three gates for Phase 1 of agent work.

1. **Technical release.** One work item goes from an imported issue to a
   human merge, in CI and in an authorized deployed test workspace.
2. **Failure recovery.** CI covers duplicate deliveries, source revision
   races, two simultaneous sends, lost acknowledgments, runtime disconnect,
   tenant isolation, stale acceptance, late events, and reopen, with no
   duplicate run and no false done state.
3. **Pilot decision.** A proposed discovery gate: two independent teams use
   the full flow in 3 of 4 consecutive weeks and each completes at least 20
   work items. Mac observes their review work and compares it with their
   prior process. A stop condition applies when teams only use intake,
   cannot reliably receive work, or still rebuild every result outside
   Oxagen.

Lanes P1-02 to P1-05 each proved their own part in CI. No test ran one item
through every step, and three failure-recovery cases had no test: two sends
at the same moment, a runtime that goes silent mid-run, and a source change
while the work runs.

`get_work_outcomes` (P1-05) already counts most of the measures the phase
lists: accepted and merged, returned, and closed work, lead time with its
sample, touches by type, cost coverage, and reopens in a mature cohort. It
could not say whether a team used the full flow in a given week, whether
sends reach a runtime, or whether a team only brings work in. It records no
revert.

## Decision

1. **The delivery gates are proven in CI by one Postgres file.**
   `release-gates.pg.test.ts` runs the technical release gate on one work
   item, from a signed GitHub delivery to a human merge, with recorded GitHub
   responses and a recorded triage answer. It adds the failure-recovery cases
   no lane covered. It runs in `unit (handlers)` with the lanes' other
   Postgres tests, so no workflow changes. `docs/specs/work/release-gates.md`
   maps each gate item to its test.

2. **The deployed gates run by hand from one runbook issue.** They need an
   authorized test workspace, the GitHub App on a test repository, a merged
   priorities record, and an enrolled host. #5243 lists each gate as a
   checkbox with its steps, the record to expect, and where its evidence goes.

3. **The pilot measures are data in `get_work_outcomes`.** It gains
   `delivery`, the sends a person made in the window, each in one bucket:
   rejected, claimed, withdrawn before a claim, or waiting, with the minutes
   from send to claim. Each week gains `entered`, `sent`, and `full_flow`.
   Every figure is counted from the work records (ADR-244). The fields are
   additions, so no consumer breaks.

4. **A week used the full flow when at least one item was accepted and
   merged in it.** An item is done only when a person accepted a pull request
   that a claimed and linked run produced, and the pull request merged. A
   done item therefore means the team used every Phase 1 step in Oxagen.
   A week of intake alone, or of sends alone, shows in `entered` and `sent`,
   and is not a full-flow week.

5. **Nothing computes the pilot decision.** No field says passed, met, or
   failed, and no code holds the thresholds. The thresholds stay in the
   phase document, and the comparison with a team's prior process is an
   observation only a person can make. The pilot reads pending until Mac
   records a decision.

6. **Each team's figures are read inside its own workspace.** The team gives
   the reader a Viewer seat, or reads the figures itself and shares them. No
   read crosses organizations.

7. **The measures describe the workflow, never a person.** No figure names
   who acted.

## Consequences

- A pull request that changes Work runs the whole release gate in CI. A step
  that breaks names itself.
- The deployed gates stay open until someone with the rig runs #5243. The
  lane's CI proof does not stand in for them.
- An operator can read the pilot measures through the API. The Outcomes page
  does not draw `delivery` or the weekly intake yet.
- Until the amendment of 2026-10-03 below, a revert was invisible and the
  pilot read reopens alone (#5244). Work now records a revert GitHub links.
- `truncated` keeps its meaning, more items than one read counts.
  `delivery.truncated` says the same for sends, at 2,000.

## Alternatives considered

- **A pilot capability that computes the verdict.** Rejected. A verdict from
  counts alone would claim validation the phase reserves for observation and
  for Mac. It would also add a contract, a route, and registry entries for
  figures one read already returns.
- **A cross-organization operator report.** Rejected. It would read other
  organizations' records outside their tenant boundary, for two teams who can
  share a seat.
- **A ClickHouse event for each step.** Rejected. The work facts are already
  the append-only record of each step (ADR-244). A second copy could disagree
  with them.
- **A full-flow week as any week with any step.** Rejected. A week of intake
  alone would count, and that is the stop condition the pilot must catch.
- **A fourth e2e spec for the gates.** Rejected for the reasons in ADR-255.
  The gates are about records, not pages, and Postgres proves them directly.

## Amendment, 2026-10-03 (#5244)

The phase document asks for revert and reopen rates in mature 30-day cohorts,
with the immature counts. Work now records a revert, so the pilot reads both.

1. **A revert is a provider fact on the send.** `reverted` is a new order fact
   kind, from the `provider` source only (ADR-244). It names the reverting
   pull request in its repository and pull request number. Its data names
   that pull request's merge commit and the number of the pull request it
   reverts, so the record says which merge it undid. Migration
   `20261003171500_item_facts_reverted.sql` widens `item_facts_kind_check` and
   `item_facts_order_check`.
2. **Work counts the revert GitHub links.** The `pull_request` webhook records
   `reverted` when a pull request merges with a description line that starts
   `Reverts <owner>/<repo>#<n>`, the line GitHub's Revert button writes, and
   `#<n>` is the pull request a send follows and has merged. Only the `closed`
   delivery of the merge counts, so editing an old pull request's description
   records nothing. The named repository must be the one the revert merged
   in, and a pull request never reverts itself. A revert made by hand without
   that line, such as `git revert` pushed to the branch, is not recorded and
   is not counted. A bare `Reverts #<n>` is not counted either. Oxagen does
   not check which branch the revert merged into, as the Spend outcome rows
   do (`revertTargetsOf` in `@oxagen/billing`). GitHub's Revert button
   targets the original base branch. The dedupe key names the send and the
   reverting pull request, so a redelivery records nothing. The revert writes
   in a transaction of its own, after the delivery's own facts, so a failure
   there cannot take those back.
3. **A revert never moves the item.** `reduceWorkItem` shows the first revert
   on the send (`OrderProjection.revert`) and changes no state: a done item
   stays done. A person reads the revert in the history and decides whether to
   reopen the item.
4. **`get_work_outcomes` gains `reverts: { cohort, reverted, waiting }`.** It
   uses the reopen cohort, the items whose done time falls 30 to 30 plus
   `days` days ago, and the same `waiting` count. An item counts as reverted
   when the send whose done time placed it in the cohort carries a `reverted`
   fact. The count is bound to the send, not to a time, because a merge seen
   before review can be reverted before the acceptance that sets the done
   time. A revert of the revert does not clear it. The field is an addition,
   so no consumer breaks.

Rejected:

- **Reopen the item on a revert.** A revert can be the right call on work that
  was still accepted correctly, and Phase 1 leaves every judgment to a person.
- **Count a revert from `git revert` commits.** A commit message says which
  commit it reverts, and matching that commit to a send's merge commit needs a
  push read and a branch rule. The Spend findings do that for their own
  measure. The pilot needs one rule a team can read and follow, and GitHub's
  link is that rule.
