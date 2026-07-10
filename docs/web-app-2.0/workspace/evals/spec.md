---
# Evals

- **Route:** `/{orgSlug}/{workspaceSlug}/evals`
- **Nav location:** workspace → primary → Activity → Evals tab
- **Priority:** P1
- **Disposition vs today:** Keep + wire nav + build write path

## Purpose
Datasets and runs for evaluating agent/model quality — the place a team checks whether an agent's answers are actually good before reselling access to it. The page and its data model already exist and are functionally complete for reading, but the route has no inbound nav link today (a shipped orphan) and every write action (creating a dataset, adding items, launching a run) currently requires the CLI.

## Primary user & jobs-to-be-done
- **Primary user:** developer or QA owner validating agent quality before wider rollout
- **JTBD:**
  - See existing eval datasets and what each contains
  - Create a new dataset manually or generate one from real traces
  - Add items to a dataset
  - Launch an eval run against a chosen model/prompt or agent
  - Track a running eval's status until it completes

## Functionality
- **Dataset list (existing):** table — columns: name, item count, source (manual/trace-derived), created-at, last run. Explainer copy for first-time users.
- **Fix:** dataset rows currently don't link anywhere — make each row link to a dataset detail view (or directly to `eval.dataset.get`-backed detail/runs list).
- **New dataset (new):** "New dataset" action — manual creation form (name, description) or "From traces" action that seeds items via `eval.dataset.from_traces`.
- **Add items (new):** within a dataset, an "Add item" action calling `eval.dataset_item.add`.
- **Run eval (new):** "Run eval" launcher — pick a target (model+prompt, or a published agent), pick a dataset, submit via `eval.run.start`; status polls via `eval.run.status` until terminal, then links to the run detail page.

## Capabilities invoked
- `eval.dataset.list` (`list_datasets`) — dataset list.
- `eval.dataset.create` (`create_dataset`) — manual dataset creation.
- `eval.dataset.from_traces` (`create_trace_dataset`) — trace-derived dataset creation.
- `eval.dataset_item.add` (`add_dataset_item`) — add an item to a dataset.
- `eval.dataset.get` (`get_dataset`) — dataset detail + item list.
- `eval.run.start` (`start_eval_run`) — launch an eval run.
- `eval.run.status` (`get_eval_status`) — poll run status until terminal.

## Data sources
Postgres (dataset and dataset-item records); ClickHouse (run results and per-item metering, read via `eval.run.status`/downstream run-detail capabilities).

## States
- **Empty:** no datasets yet — explainer plus both "New dataset" and "From traces" CTAs prominent.
- **Loading:** skeleton table rows; run launcher shows a spinner while polling `eval.run.status`.
- **Error:** inline retry for list load; failed run-start shows a toast with the failure reason, dataset/list state preserved.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/evals/page.tsx` is PARTIAL and ORPHANED — dataset list + explainer render correctly, read-only, but rows don't link anywhere and there is no nav path to this route at all. Build: nav wiring (Activity tab strip) + the create/add-item/run-launcher write path described above; row-to-detail linking.

## Vision alignment
Evals are a declared fast-follow, not the front line (per `docs/VISION.md`) — P1 here is justified purely as fixing a shipped orphan (dead nav surface) and closing a CLI-only write path, not as new front-line investment in eval tooling itself.
