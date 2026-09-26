# summarize_run

The generated name and summary of a sealed run (Mission Control mockup 2821-2835; plan gap G14; ADR-058). A fast-tier model reads the run's transcript and writes what changed; the result is stored on the run with the model id and the instant it was produced, labelled generated wherever it renders, and never stands in for the record.

## Mode

**async**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/summarize`
- MCP: none; no tool is built.
- CLI: none
- Authentication: session or API key; org Owner, Admin or Member, checked in the handler (`assertOrgRole`, `apps/app/ARCHITECTURE.md` §3.2) for the signed-in user or the key's creator (`resolveActingUserId`); a key with no recorded creator is refused `forbidden / no_principal`
- Capability name: `summarize_run`
- `mutates: true`; `agent.requiresApproval: false`; not billed as a governed action (`noBillingGate: true`). The model call is metered through `@oxagen/ai` on the organisation's funding source (`consume_assistant_tokens` when platform-funded), like every other model call. IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…`, sealed, with bodies retained |

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | as asked |
| `status` | `queued` | `get_run` carries `name` and `summary` once the job has written them |

## The job

`run.enrich` (`@oxagen/inngest-functions`, ADR-153) handles the `run/enrich` event this action sends. It reads every retained frame body in chronological chunks and asks Stella, through a tool-free governed turn on organization funding, for a name of at most 80 characters and a summary of at most 1 600. A run with no retained text gets no model call. It writes `name`, `summary`, `summary_generated_at` and `summary_model` together on `agent.agent_runs` or `tacho.sessions`, with `summary_input_digest`, `summary_observed_at` and `summary_observed_revision` as its cursor.

Each model call reports its tokens and their price, and one job spends at most `ENRICHMENT_RUN_BUDGET_USD` ($1) on a run (#3944). The job checks the budget before every reduction call. Once the job has spent it, the job reduces nothing more, writes the account from the part of the run it has read in one more call, and ends the summary with a sentence saying the account covers only the start of the run. The job's result and its log line carry the calls it made and what they cost. The turn itself writes the tokens to `token_usage`.

A run's total is capped too, at `ENRICHMENT_RUN_TOTAL_BUDGET_USD` ($5) across every job (#4312). A live run is enriched again every 30 minutes while it changes, so the per-job budget alone did not bound it. The job adds each call's price to the run's `summary_spent_usd_micros` inside the step that made the call, and a job starts with whichever is smaller: its own budget or what the run has left. When the run's cap stops a job, the account says it covers only the start of the run, as it does at the per-job budget. The job checks the budget before each reduction call and not before the account call, so a job can take the run past the cap by at most two calls: the reduction call that crossed it and the account call, each over at most one chunk. Once the run has spent its cap, the sweep no longer queues it, and a request for it through this action makes no model call. The run keeps its last account.

## Errors

- `forbidden` (403): the actor holds none of Owner, Admin, Member in the org.
- `not_found` (404): no run with that id in the caller's workspace.
- `conflict` (409), by `reason`: `run_not_sealed` (the record is not yet complete); `digest_only` (the seal recorded a `digest_only` gap: there are no bodies for a model to read, and a summary written from receipts alone would be the placeholder the interface forbids); `enrichment_disabled` (the workspace turned run enrichment off, so no summary is written for it).

The action now dispatches `run/enrich`, the same Stella path used by the automatic five-minute sweep. It reads all retained frames in chronological chunks instead of a sixty-step prefix. A repeated request with the same input digest does not spend credits again. The workspace's `runEnrichmentEnabled` setting also gates manual requests; disabling it leaves evidence intact and suppresses generated display text. The action's sealed-run and retained-body admission checks remain in place.
