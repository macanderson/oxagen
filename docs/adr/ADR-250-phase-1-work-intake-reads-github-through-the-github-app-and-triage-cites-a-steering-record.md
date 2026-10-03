# ADR-250: Phase 1 work intake reads GitHub through the GitHub App, and triage cites a steering record

- **Status:** Accepted
- **Date:** 2026-10-02
- **Amended:** 2026-10-02, only a signed-in person changes a collector (#5181).
- **Amended:** 2026-10-03, only a signed-in person syncs a collector or
  retries triage.
- **Owners:** work
- **Related:** issue #5103 (lane P1-03), `agent-work-phase-1.html` in
  `oxageninc/roadmap` (Work lifecycle, Data contract, Delivery and review),
  `mockups/pages/work-setup.md` on roadmap `main`, ADR-244 (the work records),
  #4775 (C1), #4774 (C2), #4777 (T2).

## Context

Phase 1 of agent work brings GitHub issues and typed entries in as work
items, suggests triage, and lets a person correct it. Main had the pieces as
libraries: the collector pipeline and the GitHub Issues module in
`packages/ingestion/src/collectors/` (#4801, #4779), and the work records
(ADR-244). Nothing stored a delivery, fetched an issue, reconciled, or
triaged. Lane T2 left a triage engine on `feat/t2-triage` with no PR.

The older spec gave each collector its own webhook route and signing secret,
put collector setup and the priorities record in steering files, and let
triage pick a workflow. Production has one GitHub App with one webhook URL,
steering checks that read no `work/` files, and no workflows in Phase 1.

## Decision

### Intake through the GitHub App

The GitHub App webhook route (`apps/api/src/routes/v1/github-webhook.ts`)
verifies the App's signature, then hands every `issues` and `issue_comment`
delivery to `routeGithubWorkDelivery`
(`packages/handlers/src/lib/work-intake/delivery.ts`). That finds the GitHub
collectors whose connection belongs to the delivery's installation and whose
scope names its repository. Each one runs the pipeline's doorbell in its own
tenant scope: it verifies the signature again with the same App secret,
stores the delivery once in `work.inbound_events` keyed by GitHub's delivery
id, and the route sends `work/event.received`. A paused collector stores the
delivery and gets no event. A failure is logged and never answered with an
error, because GitHub does not redeliver on its own and the reconcile reads
the issue anyway.

`work/intake-collect` fetches each named issue by id and maps what it
fetched, never the webhook body. One issue is one work item in a workspace,
whichever collector heard it (ADR-244): the store finds the item on
`(org, workspace, provider id)` under a transaction lock on that key, and
records the material fields with `recordSource`, so a new issue is a
`collected` fact and a changed subject, description, or label set is a
`source_changed` fact on the next item revision. A source update writes only
the columns the provider owns. A person's planning priority, the state, and
triage are never among them.

### Reconcile and health

Every 15 minutes `work/intake-sweep` asks for one check per collector that is
not paused, and `work/intake-check` reads up to 20 pages, one step per page.
A GitHub reconcile reads only the repositories the collector names, and fails
when the App cannot read one of them, so a lost grant reads as failing rather
than empty. The cursor moves only after a page's items are stored. A record
the provider closed before Oxagen stored it is skipped, so a first read brings
in open work and none of a repository's closed history. A collector that gains
a repository or changes its connection reads from the start again, because
the cursor is a time and the new repository's older issues were never read. Health
follows `healthOf`: lagging when a reconcile found changes a webhook missed or
the nightly count differed, failing after three failed reconciles in a row,
and a failing collector waits for `sync_work_collector`. The nightly count
counts open items the collector stored and open items in the repositories it
names, because a second collector on one repository does not store the item
twice.

### Inbound content

Oxagen keeps no unscreened bytes of a delivery: the production ports leave
out the raw store, so `raw_ref` is null. The stored envelope and each item's
subject, description, and requester pass the recorder's credential
detectors (`@oxagen/recorder/redaction`) and lose control characters. The
detectors match known credential shapes, so screened text can still hold
sensitive content, and nothing claims otherwise. Stored deliveries and result
rows are deleted after 30 days (`work/intake-prune`). Row security limits them
to their workspace, and no capability returns a delivery body.

### Collector setup

`set_work_collector` writes `work.collectors` directly. The row holds the
fields of a `collector/v1` document with every write-back switch off, and
`file_hash` is that document's SHA-256. The Work setup design puts the file in
the steering repo behind a steering PR, but the steering checks and the merge
flow read no `work/` files today, so a PR carrying one could not pass or
apply. When they do, `set_work_collector` opens the PR with the same document
and the steering sync applies `planCollectorMirror`, which the rows already
match.

### Priorities

The priorities record is a steering record: the workspace's active record
whose lineage is `work.priorities` or ends in `.work.priorities`. A person
edits it with a Context PR, and triage reads the active version's statement,
cites its numbered rules as `<lineage>#<number>`, and stores the version's
hash on each decision. With no such record, or more than one, triage records
a `triage_failed` fact that says what to fix, so the gap is visible on every
item it reads.

### Triage

The engine is T2's: one fixed system prompt, the item quoted as data inside
one JSON document whose `<` and `>` are escaped, a `triage/v1` check plus a
check that every cite and duplicate names something triage was shown, and one
retry. Phase 1 runs no workflows, so `triage/v1` allows a null workflow on a
triaged decision, and T2's route choice and workflow match stay on its branch.

`work/intake-triage` starts at most 60 runs per workspace per minute and one
at a time per item. A run reads at most 100 open items, 20,000 characters of
body, and 2,000 paths of the item's repository tree. It runs only while the
item is new, held, triaged, needs_info, or changed, while its source issue is
open, and once per item revision unless a person asks for a retry. A second invalid answer records
`triage_failed`. When the item moved to a newer revision while triage read the
older one, nothing is stored, and the change that moved it queues triage
again. When the run's retries run out, its on-failure job records
`triage_failed`. The model call goes through `@oxagen/ai` on the
organization's fast tier and is charged as in-app assistant spend, so it shows
on Billing. `@oxagen/ai` records the cost on the usage row and does not
return it, so the decision's cost stays null.

### Corrections

A person's correction is one `work.triage_corrections` row per field, against
the decision they read. `effectiveTriage` applies every correction the item
holds to its latest decision, so a later decision never undoes a person's
edit until the person clears it. A priority correction also sets the item's
planning priority. The outcome is a `triage_overridden` fact, as ADR-244
maps it. Every revision names the item version it read: the outcome moves the
version through the store, and field corrections alone move it under the row
lock.

## Path mapping

| The older spec or plan | Phase 1 code |
|---|---|
| A webhook route per collector with its own secret | The GitHub App route, `lib/work-intake/delivery.ts` |
| The fetch worker on `work/event.received` | `work/intake-collect` in `packages/inngest-functions/src/functions/work.intake.ts` |
| The reconcile and nightly count | `work/intake-sweep`, `work/intake-count-sweep`, `work/intake-check` |
| The Postgres collector store | `packages/handlers/src/lib/work-intake/collector-store.ts` |
| `work/collectors/<name>.toml` mirrored by the steering sync | `set_work_collector`, until steering checks read `work/` files |
| The priorities record named by `work/work.toml` | The steering record named `work.priorities` or `*.work.priorities` |
| `triageItem` (C0 stub) and lane T2 | `packages/work/src/triage/`, `lib/work-intake/triage-run.ts`, `work/intake-triage` |
| Corrections as training pairs | `effectiveTriage` and `revise_work_triage`. No training tables in Phase 1 |

## Consequences

- P1-05 shows `list_work_collectors`, `get_work_priorities`, the item's
  triage view, and a `triage_failed` fact as needs attention. Its Add
  collector form calls `set_work_collector`, and Edit priorities opens a
  Context PR.
- A collector reads the repositories the Oxagen GitHub App can read. A
  repository outside the installation fails the reconcile until a person
  grants it.
- Source write-back stays off. A GitHub close a person caused is observed,
  never caused.

## Alternatives considered

- **A webhook route and secret per collector.** Rejected: the App already
  signs every delivery, and a second secret per collector would be one more
  credential with nothing gained.
- **Collector files in the steering repo now.** Rejected for Phase 1: no
  check or merge path applies them yet, so a person could not add a collector.
- **A priorities table.** Rejected: the record is a steering record in the
  design, and steering already versions, reviews, and publishes records.
- **Keeping the raw delivery bytes.** Rejected: the screened envelope is
  enough to fetch by id, and unscreened bytes would need their own access
  control and retention.

## Amendment 2026-10-02: only a person changes collectors (#5181)

Mac decided that an agent may file work items, but only a person may change
collectors. A collector decides what the workspace takes in.

- `create_work_item` keeps the `api` and `mcp` surfaces and still takes an API
  key. The key's creator is recorded as the actor.
- `set_work_collector` refuses an agent run and every API key before it checks
  the role or writes anything, the way `lib/work-records/actor.ts` checks a
  work decision. An agent on its operator's machine can read the operator's
  `oxagen login` key, so a key that resolves to a person is refused too.
- `set_work_collector` is on the `api` surface only. It has no MCP tool.

## Amendment 2026-10-03: a person syncs a collector and retries triage

`sync_work_collector` and `retry_work_triage` are a signed-in person's, the
way `set_work_collector` is.

- A sync is a collector change. It forces a reconcile, and a reconcile that
  finishes moves a failing collector back to its schedule. The failing state
  waits for a person, so an agent with its operator's key must not lift it.
- Triage runs once per item revision unless a person asks for a retry. Each
  retry is a model call the organization pays for, so an agent must not ask
  for one with its operator's key.
- Both handlers refuse an agent run and every API key before they check the
  role or read anything, including an `oxagen login` key that resolves to a
  person. Both are on the `api` surface only and have no MCP tool.
- A repeated request sends one event. A sync's event id names the collector
  and the minute. A retry's event id names the item and its version, and each
  triage run that records a result or a failure moves the version.
