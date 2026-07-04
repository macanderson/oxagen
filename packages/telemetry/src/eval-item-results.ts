import { chInsert, chSelect } from "./tenant";

// Tenant-scoped per-item eval results (Evals v1). Written by the eval run
// executor (packages/inngest-functions) and read back by eval.run.get. The
// org_id/workspace_id columns are stamped by chInsert from the active tenant
// scope — callers MUST NOT pass them — and chSelect enforces the org_id filter
// on read (fail-closed), so one workspace can never read another's results.

/** One append-only row per (run, dataset item). Mirrors the eval_item_results DDL. */
export interface EvalItemResultRow {
  run_id: string;
  dataset_id: string;
  item_id: string;
  target_kind: string;
  model: string;
  judge_model: string;
  score: number;
  correctness: number;
  faithfulness: number;
  passed: 0 | 1;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd_micros: number;
  status: "completed" | "failed";
  error_class: string;
  output: string;
  rationale: string;
}

/**
 * Insert per-item eval results. No-ops on an empty array. The active tenant
 * scope stamps org_id/workspace_id onto every row (chInsert), so a run
 * executor must wrap this in runInTenantScope({ orgId, workspaceId }, …).
 */
export async function insertEvalItemResults(
  rows: readonly EvalItemResultRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await chInsert("eval_item_results", rows as ReadonlyArray<Record<string, unknown>>);
}

/**
 * Read every result row for a run, newest item first. Tenant-filtered by the
 * active scope via chSelect (throws if unscoped). Ordered so eval.run.get can
 * render the drill-down deterministically.
 */
export async function selectEvalItemResults(
  runId: string,
): Promise<EvalItemResultRow[]> {
  const res = await chSelect<EvalItemResultRow>({
    query: `
      SELECT
        run_id, dataset_id, item_id, target_kind, model, judge_model,
        score, correctness, faithfulness, passed,
        latency_ms, input_tokens, output_tokens, cost_usd_micros,
        status, error_class, output, rationale
      FROM eval_item_results
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND run_id = {runId:String}
      ORDER BY created_at DESC, item_id ASC
    `,
    params: { runId },
  });
  return res.data;
}
