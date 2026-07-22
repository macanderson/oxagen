---
# Eval Run Detail

- **Route:** `/{orgSlug}/{workspaceSlug}/evals/runs/[runId]`
- **Nav location:** workspace → primary → Activity → Evals tab → dataset detail / runs list → row click
- **Priority:** P2
- **Disposition vs today:** Keep (add inbound link)

## Purpose
The scored results of a single eval run: overall pass rate, per-item scores across quality axes, and cost — the record that lets a team decide whether an agent is good enough to ship or resell. The page itself is complete and well-built; its only defect is that nothing links to it.

## Primary user & jobs-to-be-done
- **Primary user:** developer or QA owner reviewing eval results
- **JTBD:**
  - See overall pass rate and average score for a run at a glance
  - Compare per-item scores across quality dimensions (correctness, faithfulness)
  - See latency, tokens, and cost per item
  - Know which judge and which target (model/agent) produced this run
  - Get here from the dataset or run list without hunting for a URL

## Functionality
- **Summary header:** status, average score, pass rate, judge used, target (model/agent) evaluated.
- **Score chart:** reaviz bar chart of per-item or per-axis scores.
- **Per-item results table:** columns: item, score, correctness, faithfulness, latency, tokens, cost. Row expand for full item input/expected/actual.
- Back button to the originating dataset/runs list (currently the only inbound/outbound link on the page).

## Capabilities invoked
- `eval.run.get` (`get_eval_run`) — run summary + per-item results.
- `eval.run.status` (`get_eval_status`) — live status while a run is still in progress.

## Data sources
Postgres (run summary, judge/target metadata); ClickHouse (per-item metering — latency/tokens/cost pipe).

## States
- **Empty:** a run with zero completed items yet (still starting) shows a "run starting" placeholder instead of an empty chart/table.
- **Loading:** summary header and chart/table load independently; status polls while run is non-terminal.
- **Error:** not-found for an invalid `runId`; inline retry if `eval.run.get` fails after the run is known to exist.

## Existing implementation
- **Today:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/evals/runs/[runId]/page.tsx` is COMPLETE but orphaned — status, avg score, pass rate, judge/target, reaviz bar chart, per-item results (score/correctness/faithfulness/latency/tokens/cost) all render correctly. The only inbound link is its own Back button. Fix: wire real inbound links from the dataset detail view and the Evals runs list once those exist (see Evals spec).

## Vision alignment
Evals are a fast-follow, not the front line — P2 reflects a complete page needing only a nav-wiring fix, lower urgency than the P1 orphan-fix on the Evals list itself since this page's data is unreachable only through the parent, not broken on its own.
