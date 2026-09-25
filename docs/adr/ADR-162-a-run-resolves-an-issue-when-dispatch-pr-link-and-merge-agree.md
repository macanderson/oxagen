# ADR-162: A run resolves an issue when dispatch, PR link and merge agree

Status: Accepted
Date: 2026-09-23
Related: ADR-043, ADR-058, ADR-099, ADR-113, ADR-161
Refs: #4013

## Context

You want to know which issues a run resolved, and you want the answer to come from facts rather than from what the agent said. Today Oxagen cannot answer. Three kinds of record are needed, and the code holds one and a half of them.

- **The dispatch.** No code records that Oxagen handed an issue to an agent. `dispatch_command` (`packages/oxagen/src/contracts/tacho.command.dispatch.ts`) queues `pause`, `resume`, `cancel`, `steer`, and `message` to a live run through `tacho.tacho_control_commands`, and knows nothing about issues. `packages/handlers/src/run-issue-provider.ts` goes the other way: a run's outcome opens an issue. This ADR defines the dispatch record.
- **The pull request a run opened.** PR #4009 adds the `oxagen:pr_link` frame, sealed from Claude Code's `pr-link` transcript record with attrs `pr_number`, `pr_url`, and `pr_repository`. (Amended 2026-09-25, #3944: the frame now writes `pr.number`, `pr.url`, and `pr.repository`, the names the `pr_open` effect frame uses. Readers accept both spellings for frames already stored.) It reaches the control plane through `ingest_tacho_events` on the run's hash chain. ADR-161 gives backfilled runs the same frame.
- **The merge and what it closed.** GitHub records the issues a merged pull request closed in the PR's `closingIssuesReferences` GraphQL field, and on each issue's `closed` timeline event, whose `commit_id` names the closing commit. The GitHub App webhook route, `apps/api/src/routes/v1/github-webhook.ts`, verifies each delivery's HMAC against the sending App's secret, handles `ping`, `installation`, and `installation_repositories`, and fans the rest out to ingestion. It has no `pull_request` branch, and it does not read `x-github-delivery`.

The laptop and the web lose contact. A host's frames wait in its WAL until the next successful ingest. A webhook can be missed or delivered twice. Any design that depends on arrival order, or on one delivery, reports a wrong answer after an outage.

ADR-113 reserves "Dispatch" as a product name for the founder. This ADR uses dispatch as a verb and as the name of a record, not as a feature name.

## Decision

### Resolution rule

An issue I is resolved by run R through pull request P when all four facts hold:

1. I was dispatched to R.
2. R's chain recorded an `oxagen:pr_link` frame naming P.
3. P merged.
4. GitHub lists I in P's `closingIssuesReferences`, or I's `closed` timeline event names P's merge commit.

Oxagen infers nothing from branch names, commit messages, PR titles, or model output. An issue closed any other way is reported as "Closed outside the record" and is not resolved by R.

### Dispatch record

A new capability, `dispatch_issue`, hands a GitHub issue in a bound repository to a run or to an agent. The issue must be in a repository bound to the workspace through `ingestion.repository_binding_heads`, and the caller must hold the agent's operate permission.

- **To a live run.** The handler writes the dispatch with `run_session_uuid` set and queues a `message` command through `tacho.tacho_control_commands`, carrying the issue reference and the dispatch id. The binding is recorded at dispatch time, whether or not the host is online.
- **To an agent.** The handler writes the dispatch with `run_session_uuid` null. The next run of that agent started with `OXAGEN_DISPATCH_ID=<id>` (or `oxagen run --dispatch <id>`) claims it: its `agent_start` carries `attrs["oxagen.dispatch_id"]`, and ingest binds the run with a conditional update that succeeds only while the dispatch is unclaimed. The first claim wins, and a later claim is recorded as refused.

Companion capabilities are `get_issue_dispatch`, `list_issue_dispatches`, and `abandon_issue_dispatch`. All four declare `api`, `mcp`, and `cli` surfaces, `noBillingGate: true`, and an app binding.

### States

| State | Entered when |
|---|---|
| `dispatched` | The dispatch row is written. |
| `in_progress` | A run is bound and the control plane has received a frame from it sealed after the dispatch. |
| `pr_opened` | The bound run's chain carries a `pr_link` frame. |
| `merged` | A PR the run linked merged. |
| `resolved` | The four facts hold for one PR the run linked. |
| `abandoned` | An operator called `abandon_issue_dispatch`, or the run sealed and every PR it linked closed unmerged. |

The state is derived from stored facts by one pure function, `evaluateIssueDispatch(facts)`, not advanced step by step. `resolved` and `abandoned` are terminal. `abandoned` ends the record for that dispatch. A new dispatch of the same issue is a new row.

### Storage

Postgres holds state, in the `tacho` schema beside the sessions it references.

- `tacho.issue_dispatches`: id (`dsp_`), org, workspace, `repository_binding_id`, provider (`github`), `issue_number`, `issue_node_id`, `agent_id`, `run_session_uuid` (the root session, nullable until claimed), `dispatched_by_principal_id`, `control_command_id`, `state`, `state_changed_at`, `resolved_pr_id`, and `abandoned_reason`. A partial unique index allows one open dispatch per issue per workspace.
- `tacho.run_pull_requests`: one row per (root session, `pr_repository`, `pr_number`), written from the `pr_link` frame, with the frame's `event_id_idem`. It references the matching `github_pull_request_facts` row and copies none of its fields.
- `tacho.github_pull_request_facts`: one row per (repository, `pr_number`), holding `pr_node_id`, `merged_at`, `merge_commit_sha`, `closed_unmerged_at`, and `closing_issue_node_ids`, written from the webhook or reconciliation whether or not a run has linked the PR yet. This row is what lets the merge arrive before the `pr_link`.
- `tacho.issue_resolutions`: unique on `dispatch_id`, with the PR, the matching rule (`closing_reference` or `merge_commit_close`), and `resolved_at` (when Oxagen first held all four facts), and the webhook delivery or reconcile run that supplied the last fact.

ClickHouse holds the events, append-only: `issue_dispatch_events`, one row per fact received and per state change, with the source (`capability`, `ingest`, `webhook`, `reconcile`) and its id (the `event_id_idem`, `x-github-delivery`, or reconcile run id). The Run page's history of a dispatch reads from it.

The implementation PR carries the Atlas and ClickHouse migrations and the `migration-required` label.

### Webhook

The route gains a branch for `pull_request` with `action = closed`, and for `issues` with `action = closed`. It reads `x-github-delivery` and writes it to a dedupe table before acting, so a redelivery does nothing. For a merged pull request it emits an Inngest event. The job reads `closingIssuesReferences` through GraphQL with the installation token from `getInstallationToken` in `@oxagen/github`, writes `github_pull_request_facts`, and runs `evaluateIssueDispatch` for every dispatch in that repository whose run linked the PR. For a closed issue it reads the `closed` timeline event's `commit_id` and stores it on the issue's fact row. The laptop plays no part in this path.

### Order and idempotency

Each fact is stored under its own natural key, and every write is an upsert that keeps the first value for an immutable field (`merged_at`, `merge_commit_sha`). After any fact is written, the handler that wrote it calls `evaluateIssueDispatch` for the dispatches the fact touches. The function reads all stored facts, so the result does not depend on which one arrived last.

- A `pr_link` frame re-sent after a lost ack has the same `event_id_idem`, and ingest writes no second row.
- A webhook redelivery has the same `x-github-delivery`, and the dedupe table stops it.
- Two evaluations racing to resolve the same dispatch collide on the unique `dispatch_id` in `issue_resolutions`, and one insert wins.

### Offline laptop

When the laptop is offline, the dispatch still records, and a dispatch to a live run waits in `tacho_control_commands` until the host next polls. The run's `pr_link` frame waits in the WAL. The merge still arrives by webhook, and `github_pull_request_facts` stores it. The dispatch stays in `in_progress` or `merged` until the WAL ships. When the `pr_link` lands, evaluation runs and the dispatch resolves. `resolved_at` is when Oxagen held all four facts, and `merged_at` is when GitHub merged P. The Run page shows both.

### Reconciliation

An Inngest cron in `packages/inngest-functions` catches missed webhooks.

- Every 15 minutes, for each dispatch in `pr_opened` or `merged`, it reads the linked PRs' state and `closingIssuesReferences` from GitHub, writes the facts, and evaluates.
- Once a day, for each open dispatch whose issue GitHub shows closed, it reads the closing event. A close with no matching PR fact records "Closed outside the record".
- Once a day, it lists the App's failed webhook deliveries from GitHub and asks for redelivery of those in the last three days.

Each run writes a `reconcile` row to `issue_dispatch_events` with the count of facts it changed. A reconcile that changes a fact the webhook should have delivered is how a missed delivery becomes visible.

### Link health

The dispatch panel and each host row on Fleet show the laptop-to-web link with three facts: the last ingest received from the host, the last `pr_link` frame received from it, and the age of the oldest unshipped WAL entry, which the daemon adds to the health it reports. The link reads "Current" when the host has ingested in the last five minutes, "Delayed" when a run is live and the last ingest is older, and "Offline" after an hour. The panel also shows the last GitHub delivery the App received for the repository. A dispatch waiting on a fact names the fact it waits for: "Waiting for the run's PR link" or "Waiting for GitHub to report the merge".

## Consequences

A resolved issue is a claim the record can back: the dispatch, the chain frame, and GitHub's own closing reference are each stored with their source id.

Resolution covers only issues dispatched through Oxagen. An issue an agent fixes without a dispatch is not counted, and neither is one closed by hand. That undercounts on purpose.

A PR that fixes an issue without a closing keyword or a manual link in GitHub does not resolve it. The fix is to link the issue in GitHub, and reconciliation then picks it up.

The first release covers GitHub only. Linear issues need their own closing-reference source.

Resolution depends on PR #4009's `pr_link` frame and, for runs that predate the collector, on ADR-161's backfill.

## Definition of done

- [ ] `dispatch_issue`, `get_issue_dispatch`, `list_issue_dispatches`, and `abandon_issue_dispatch` contracts, handlers, and docs, with MCP and CLI surfaces and an app binding.
- [ ] `tacho.issue_dispatches`, `tacho.run_pull_requests`, `tacho.github_pull_request_facts`, `tacho.issue_resolutions`, and the webhook delivery dedupe table, with Atlas migrations and RLS.
- [ ] ClickHouse `issue_dispatch_events` with its migration.
- [ ] Ingest binds a claiming run from `oxagen.dispatch_id` with a first-claim-wins update, and writes `run_pull_requests` from `pr_link` frames.
- [ ] `evaluateIssueDispatch` as a pure function, with a test for every order in which the four facts can arrive, and for each non-resolving case (no closing reference, closed outside the record, closed unmerged, second claim).
- [ ] The webhook route handles `pull_request` closed and `issues` closed, dedupes on `x-github-delivery`, and reads `closingIssuesReferences` through the installation token.
- [ ] The reconcile cron with its three sweeps, each writing a `reconcile` event.
- [ ] A test that ships a `pr_link` after the merge webhook and asserts the dispatch resolves then.
- [ ] The daemon reports the age of its oldest unshipped WAL entry.
- [ ] Link health on the dispatch panel and the Fleet host row, and the "waiting for" line, covered by component tests.
- [ ] `docs/specs/tacho/` and the published docs describe dispatch, the states, and the resolution rule.
