# Agent work Phase 1 release gates

**Status:** Accepted on 2026-10-02 (#5241, ADR-286). This page maps each release gate in `agent-work-phase-1.html` (oxageninc/roadmap, Release gates) to what proves it. It does not say a gate passed. A gate passes on evidence: a CI run on a commit, or a deployed check recorded on the runbook issue.

Phase 1 has two kinds of gate.

- **Delivery gates** prove the product works: the technical release gate and the failure-recovery gate. CI proves each one on recorded providers. The deployed check runs by hand in an authorized test workspace from #5243.
- **The pilot** is the product gate. It asks whether teams use Work. The work records count its measures, and Mac decides it. Nothing in the code marks it passed.

## Where the CI proof runs

Every test below runs on Postgres in CI's `unit (handlers)` job, except where the table names another job. The job migrates a fresh database with Atlas first, and a test file fails on CI when `DATABASE_URL` is missing, so a green job means the cases ran. A draft pull request skips `unit`, so read the run of a ready pull request or of `main`.

| File | What it holds |
|---|---|
| `packages/handlers/src/lib/work-release/release-gates.pg.test.ts` | One work item through the technical release gate, from a signed GitHub delivery to a human merge, and the failure-recovery cases the lanes' own files did not cover (P1-06) |
| `packages/handlers/src/lib/work-intake/work-intake.pg.test.ts` | Intake and triage on recorded GitHub responses (P1-03, ADR-250) |
| `packages/handlers/src/lib/work-records/dispatch.pg.test.ts` | Send, claim, run link, review checks, Accept, and merge (P1-04, ADR-251) |
| `packages/handlers/src/lib/work-records/store.pg.test.ts` | The work record store: stale actions, state reduction, sends, and reopen (P1-02, ADR-244) |
| `packages/handlers/src/lib/work-read/read.pg.test.ts` | The Work reads, and the Outcomes figures (P1-05) |
| `packages/database/integration/work-rls.test.ts` | Row security for briefs, orders, and facts, as `oxagen_app`, in the `rls-integration` job (P1-02) |
| `packages/work/src/records/reduce.test.ts` | The reducer gives one state for every order of a fact set, in `unit (rest)` (P1-02) |
| `apps/app/scripts/work-walk/` | The Work pages in a real browser, both themes, a phone width, the keyboard, and a Viewer, in `work-surfaces-walk.yml` on ready pull requests that touch Work. The walk is advisory, not a required check (ADR-255), so a gate that cites it must cite a walk run on the exact commit |

## Technical release

The gate: "In CI and an authorized deployed test workspace, import an issue, correct triage, approve and send, observe the runtime claim, collect a PR, block stale or failing checks, accept the current head, and observe a human merge. Record the exact revision and run URLs."

The release-gate file runs these steps on one work item, in order. Each step is one test case.

| Step | Case in `release-gates.pg.test.ts` | Deployed check |
|---|---|---|
| Import an issue | 1. A signed `issues.opened` delivery becomes one work item, and the same delivery again changes nothing | #5243 T1 |
| Correct triage | 2. Triage's suggestion is Oxagen's P2 with its reason and its cite of the priorities record. A person's P1 holds, and a later triage run that answers P3 leaves it | #5243 T2 |
| Approve and send | 3. The reviewer's brief is approved, and Send opens one send however often it is pressed | #5243 T3 |
| Observe the runtime claim | 4. The agent's host claims the send once, a lost answer gets the same claim, and another host is refused | #5243 T4 |
| Collect a pull request | 5 and 6. One run links and a second run is stopped. The host seals the run, and `recordRunEnded`, the function the `cost/run.sealed` step calls, moves the item to review once. The run's pull request links with its head and required checks | #5243 T5 |
| Block stale or failing checks | 6 to 8. A failing check, a new head, and a check that has not reported each block Accept. The new head arrives through `recordWorkOrderPullRequest`, the GitHub App route's entry, which reaches only the workspaces connected to the delivering installation | #5243 T6 |
| Accept the current head | 8. Accept records an acceptance on the new head and merges nothing | #5243 T7 |
| Observe a human merge | 9. The merge, delivered through the route's entry, marks the item done | #5243 T8 |

Every case in the file, here and under Failure recovery, ends on `expectGateInvariants`. It reads the item and checks at most one open send, one stored row and one `work_order` command per send, at most one linked run per send, and no done state without an acceptance of the merged head.

## Failure recovery

The gate: "CI covers duplicate deliveries, source revision races, two simultaneous sends, lost acknowledgments, runtime disconnect, tenant isolation, stale acceptance, late events, and reopen. No duplicate run or false done state."

| Gate item | Proof in CI | Deployed check |
|---|---|---|
| Duplicate deliveries | `release-gates.pg.test.ts` steps 1, 3, 4, 5, 7, and 9: a repeated issue delivery, Send, acknowledgment, claim, run-end event, pull request webhook, and merge each change nothing. `work-intake.pg.test.ts`: a repeated delivery id, and a second collector on the same repository, leave one work item | #5243 F1 |
| Source revision races | `release-gates.pg.test.ts`: a source change while the work runs keeps the send's brief, and Accept needs a newly approved brief. `work-intake.pg.test.ts`: an older read that lands late never overwrites a newer copy. `store.pg.test.ts`: a brief written against an older revision is refused. `dispatch.pg.test.ts`: an Accept made on a version a webhook has moved is refused | #5243 F2, F3 |
| Two simultaneous sends | `release-gates.pg.test.ts`: the same Send twice at once, one item to two agents at once, and two items to one agent at once each open one send and one command | #5243 F4 |
| Lost acknowledgments | `release-gates.pg.test.ts` steps 3 and 4: a retried Send returns the same send and command, and a repeated claim returns the same prompt. `dispatch.pg.test.ts`: a retried stop queues no second cancel, and a repeated acknowledgment records once | #5243 F5 |
| Runtime disconnect | `release-gates.pg.test.ts`: a runtime that goes silent mid-run keeps Accept blocked, reads Stopping until it confirms, and has a second run stopped. A runtime that never comes back has its run sealed by the 12-hour idle close (`closeIdleSession`, outcome `unknown`), and the run's end moves the send to review with no acceptance and no done state. `dispatch.pg.test.ts`: a send no runtime confirmed can be withdrawn, and a run that links later is stopped | #5243 F6 |
| Tenant isolation | `release-gates.pg.test.ts` step 10: from another workspace in the same organization, every action on the item is refused as not found. That covers the read, the triage correction, the brief save and approval, Send, claim (even by the send's own host), reject, run link, stop, withdraw, return, Read checks, Accept, close, and reopen. A pull request delivery, a run's pull request, and a run end record nothing there. Another organization cannot read or claim the item. Outcomes and the send targets of an empty workspace and of the other organization count none of it, and the item's facts, sends, and commands stay as they were. `work-rls.test.ts` in `rls-integration`: another organization or workspace reads no brief, order, or fact, and a forged organization is refused | #5243 F7 |
| Stale acceptance | `release-gates.pg.test.ts` step 7, and a merge of a new head while the only acceptance names the old head stays in review. `dispatch.pg.test.ts`: a new head voids the acceptance | #5243 F8 |
| Late events | `release-gates.pg.test.ts` step 9: a late head webhook, a redelivered run-end event, and a claim after done change nothing. `reduce.test.ts`: every order of a fixed fact set reduces to the same state | #5243 F9 |
| Reopen | `release-gates.pg.test.ts` step 12: a reopen keeps the history, needs a new brief, and a retry of the old send starts nothing. `store.pg.test.ts`: a closed item reopens on a new revision | #5243 F10 |

## Pilot measures

The phase's pilot decision is a proposed discovery gate: two independent teams use the full flow in 3 of 4 consecutive weeks, and each completes at least 20 work items. Mac also observes their review work and compares it with their prior process. These are proposed decision thresholds, not traction claims.

`get_work_outcomes` counts the measures from the work records. No figure is a pass, a fail, or a score, and none names a person. ADR-286 records why.

| Phase measure | Field |
|---|---|
| Accepted and merged, returned, and cancelled work, each on its own | `accepted_merged`, `returned`, `closed` |
| Median and 90th percentile collection-to-merge time, with the sample | `lead_time` |
| Touches by type | `touches` |
| Execution cost coverage and unknowns | `cost.runs`, `cost.known_runs` |
| Reopen rate in a mature 30-day cohort, with the immature count | `reopens.cohort`, `reopens.reopened`, `reopens.waiting` |
| Revert rate | Not recorded yet (#5244) |
| A week that used the full flow | `weeks[].full_flow`: at least one item was accepted and merged that week. Only a week with `weeks[].complete` true counts |
| Work items completed | `items_completed`: distinct items accepted and merged in the window. A send is not an item |
| Stop condition: teams only use intake | `weeks[].entered` beside `weeks[].sent` |
| Stop condition: teams cannot reliably receive work | `delivery`: sends claimed, rejected, withdrawn, and waiting, and `delivery.claim_minutes` |
| Stop condition: teams still rebuild every result outside Oxagen | An observation. No field measures it |
| Review work against the team's prior process | An observation. `touches.per_item` and `lead_time` are the Oxagen side of it |

### How to read the measures

1. Mac names the pilot teams. Each team is one workspace, and two teams are independent when they sit in different organizations. Record each team's workspace and its first pilot week in the planning service, not the people.
2. Each team gives the reader a Viewer seat in its workspace, or reads the figures itself and shares the answer. The read takes a signed-in session or an API key: `POST /v1/<org>/<workspace>/work/outcomes/get` with `{"days": 35}`, so four whole weeks fit in the window.
3. Every Monday, read each team's figures and record each week with `complete` true: its `full_flow`, `accepted_merged`, `entered`, and `sent`, with `delivery`, `touches`, `lead_time`, and `cost`. The current week and a week the window cuts read `complete: false`, and they never count toward "3 of 4 consecutive weeks".
4. For "at least 20 work items", count the team's finished items with `items_completed`, read over a window that covers the whole pilot. Do not count sends, and do not add up weekly records, because an item reopened and finished again can show in two of them.
5. When `truncated` or `delivery.truncated` is true, the read stopped at its cap. Read a shorter window.

The product gate stays pending until those observations exist and Mac records the decision. Phase 2 entry needs the technical gates passed, and at least one pilot that names repeated manual evidence checking or batch dispatch as a real bottleneck and wants to keep using Work.
