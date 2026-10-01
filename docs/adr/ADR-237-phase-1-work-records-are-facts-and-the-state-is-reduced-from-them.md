# ADR-237: Phase 1 work records are facts, and the state is reduced from them

- **Status:** Accepted
- **Date:** 2026-10-01
- **Owners:** work
- **Related:** issue #4897 (lane P1-02), `agent-work-phase-1.html` in
  `macanderson/oxagen-roadmap` (Data contract, Work lifecycle, Delivery and
  review), the P1-01 inventory on oxagen-roadmap#272, the decision on
  oxagen-roadmap#279, migration `20261001100000_work_records.sql`,
  `packages/work/src/records/`, `packages/handlers/src/lib/work-records/store.ts`.

## Context

Phase 1 of agent work sends one work item to one agent and finishes it only
when a person accepts the reviewed pull request and it merges. Lanes P1-03
(intake and triage) and P1-04 (dispatch and results) both write a work
item's life: a source change, a triage suggestion, an approved brief, a send,
a runtime's claim, a head commit, a check, an acceptance, a merge. They write
from webhooks, retries, and people, in no reliable order.

Main had the C0 work schema (`20260929000000_work_schema.sql`): `work.items`
with a state column, triage tables, and done-record tables. It had no
revision, no concurrency token, no brief, no work order, no history, and no
`running` or `review` state. Its only source key was
`(collector_id, provider_id)`, so two collectors that read one GitHub issue
made two work items. `work.triage_decisions` stored an unknown cost as 0.

## Decision

### Facts are the record

Every change to a work item is an append-only row in `work.item_facts`. A
fact names its kind, its trusted source, the item revision it belongs to,
and the links it carries: a brief and its digest, a work order, a pull
request, a head commit, a run, a criterion. The item's state is a projection
of its facts, computed by `reduceWorkItem` in `@oxagen/work/records`. The
store writes that projection to `work.items.state` in the same transaction
as the facts, so the stored state always equals the reduction of the stored
facts.

The reducer depends on nothing about arrival. It sorts facts by item
revision, then the time each fact names, then kind, then dedupe key, and
each rule reads a binding (a revision, a send, a head commit) or the
presence of a kind. The same facts in any order reduce to the same state.

This is a history of one work item, not a general event store. Audit stays
in the ClickHouse `audit_events` row each `invoke()` writes, and run cost
stays in `cost.run_totals`.

### Who may report what

Each fact names one of five sources: `provider`, `runtime`, `agent`,
`person`, or `oxagen`. `FACT_SOURCES_BY_KIND` lists the sources each kind
accepts, so an acceptance comes only from a person and a merge only from the
provider. The agent may record only `criterion_claimed`, and a claim never
moves the state. An agent stopping is not acceptance.

### Revisions and versions

`work.items.material_revision` moves on three causes, and never back:

- a material source change: the subject, description, or labels
  (`sourceDigest`, which leaves the provider's update time out, so a touch
  that changes nothing material moves nothing)
- an edit of an approved brief
- a reopen

`work.items.version` moves by one on every write through the store. Every
person's decision names the version it was made on, and the store refuses a
mismatch with `stale_version`.

### Acceptance brief

A brief revision is an immutable row in `work.briefs` holding a
`work-brief/v1` document (`packages/work/schemas/work-brief.v1.json`) and its
RFC 8785 SHA-256 digest. Each revision names the item revision it was written
against. Approval is a `brief_approved` fact that names the digest, and the
database holds at most one per item revision. Oxagen issues criterion ids
(`c1`, `c2`, and on): a criterion keeps its id through every edit, and a
removed id is never issued again. A brief carries no verdict.

### Work order

A send is a row in `work.orders`. Its send facts never change: the brief
revision and digest, the item revision, the target agent and runtime, the
runtime's tier at send, the operator, the mandate, the repository, a budget
reservation where the tier supports one, and the idempotency key
`<item>:r<brief revision>:s<send>`. Two columns move once, from null:
`released_at` frees the agent when the run ends or the send is over, and
`closed_at` ends the send so the item may be sent again. Partial unique
indexes hold one open send per item and one unreleased send per agent, which
is the atomic capacity claim. A composite foreign key ties each order to its
brief's revision and digest.

A send that ended (stopped, returned, withdrawn, or rejected) stays ended.
The store refuses a runtime's claim on an ended send, so the runtime does not
start it, and the database's one-open-send rules stay true.

### Stale actions

`admitDecision` refuses a person's action that rests on a stale read, with a
code a handler passes through:

| Code | When |
|---|---|
| `stale_version` | The item changed since the caller read it, or a send key names an old send |
| `stale_revision` | The caller acted on an item revision that is no longer current, or approves a brief written against one |
| `stale_brief` | The caller named a brief revision or digest that is not the latest or the approved one |
| `stale_head` | The caller accepted a head commit that is no longer the pull request's head |
| `not_allowed` | The state forbids the action, such as Accept with a required check missing |

Accept fails closed. A required check that is missing, failing, cancelled,
skipped, or unread blocks it. When the base branch requires no check, Accept
rests on the person's tick for every criterion, and the acceptance names the
head commit (oxagen-roadmap#279). Acceptance merges nothing. Done means
accepted and merged, in either order.

### States

`work.items.state` keeps main's values and adds `running` and `review`, so a
list filters on one indexed column. Deriving them from the work order would
make every list join the orders. Invalid triage output is a `triage_failed`
fact, and the item stays `new`.

### Source identity

`items_source_uniq` on `(org_id, workspace_id, provider_id)` makes one
provider item one work item in a workspace, whichever collector heard it, and
a soft-deleted row keeps its key. A provider id must be unique across the
workspace's connections: GitHub's is the issue's node id, which also survives
a repository rename (ADR-121), so the repository is recorded beside the key
(`source_repository`) and not in it. `items_provider_uniq` stays for a
collector with no connection.

### Authorization

A work item grants no authority. `workActionRoles` maps each action to the
roles `assertOrgRole` checks: every workspace role may read, and a workspace
Owner or Member, or an org Owner or Admin, may act. Approving a brief and
accepting work belong to the `run.approve` permission bundle, and every
other change to `run.control`. The send also checks two duties: the sender
operates the target agent, and in a regulated workspace the approver cannot
send.

### Unknown stays unknown

`work.triage_decisions.model` and `cost_usd` are nullable with no default. An
unknown cost is null, never 0.

## Mapping

| Phase 1 object | Storage | Facts | Capabilities |
|---|---|---|---|
| Work item | `work.items`: source identity, `material_revision`, `version`, `source_digest`, `source_repository`, `state` | `collected`, `entered`, `source_changed`, `closed`, `reopened` | Registered by P1-03 (manual entry) and P1-05 (reads) |
| Triage decision | `work.triage_decisions` (append only, `item_revision`), `work.triage_corrections` | `triage_recorded`, `triage_failed`, `triage_overridden` | Registered by P1-03 |
| Acceptance brief | `work.briefs` | `brief_saved`, `brief_approved` | Save and approve are registered with P1-04's mutations, under `run.control` and `run.approve` |
| Work order | `work.orders` | `send_requested`, `send_delivered`, `send_rejected`, `send_withdrawn`, `claimed`, `run_linked`, `run_ended`, `stop_requested`, `stopped` | Send, withdraw, and stop by P1-04, which delivers through `tacho.control_commands` and reuses `dispatch_command` for a live run |
| Evidence and review | `work.item_facts` with the head commit, pull request, run, and criterion | `pr_linked`, `head_observed`, `checks_required`, `check_observed`, `criterion_claimed`, `returned`, `accepted`, `merged`, `pr_closed` | Return and accept by P1-04. The pull request and head come from `get_run_work` and `tacho.run_pull_requests`, and the merge from the GitHub `pull_request` webhook |
| History | `work.item_facts` | every kind above | `invoke()` audit rows in ClickHouse, run cost in `cost.run_totals` |

The store in `packages/handlers/src/lib/work-records/store.ts` is the one
write path: `recordSource`, `saveBrief`, `approveBrief`, `openWorkOrder`,
`appendFacts`, and `reopenWorkItem`. A later lane writes a work record through
these and nothing else.

## Consequences

- P1-03 creates the item row (number and public id) and then calls
  `recordSource`. Its collector store keys on the source identity above.
- P1-04 records `send_withdrawn` only when the runtime can no longer claim the
  send, and treats a refused claim as "do not start". It records
  `checks_required` from the base branch's protection on the exact head
  before a person accepts.
- `work.items.done_record_digest`, `work.done_records`, and
  `work.done_verdicts` stay as C0 and the R lanes left them. Phase 1 writes
  none of them and links to no route that reads them.
- A new fact kind needs a migration for the `item_facts_kind_check`
  constraint, the same list in `@oxagen/work`, and a rule in the reducer. A
  test in the store suite fails when the lists differ.

## Alternatives considered

- **Derive `running` and `review` from the work order.** Rejected: every list
  and count would join the orders, and the item's state would live in two
  places.
- **Keep `(collector_id, provider_id)` as the only key.** Rejected: two
  collectors that read one repository make two work items, which the phase
  spec forbids.
- **Put the repository in the source key.** Rejected: a rename would split one
  issue into two items.
- **Store the approval on the brief row.** Rejected: the row would have to
  change, and an immutable brief is the point.
- **Store the state and update it in place, with no history.** Rejected: a
  late webhook or a retry would overwrite a newer state, and nothing could
  show why the item is where it is.
