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
- A revert is invisible until Work records one (#5244). The pilot reads
  reopens alone until then.
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
