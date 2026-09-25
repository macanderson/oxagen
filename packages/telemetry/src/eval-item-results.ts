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
  await chInsert(
    "eval_item_results",
    rows as ReadonlyArray<unknown> as ReadonlyArray<Record<string, unknown>>,
  );
}

/**
 * Most rows selectEvalItemResults returns for one run. A run writes one row per
 * dataset item, so a large dataset would otherwise return every row in one
 * response.
 */
export const EVAL_ITEM_RESULTS_MAX_ROWS = 1000;

/**
 * Most characters of `output` and of `rationale` selectEvalItemResults returns
 * per row. Both columns hold free text of any length. ClickHouse truncates them
 * with substringUTF8, so the cut never splits a multi-byte character.
 */
export const EVAL_ITEM_TEXT_MAX_CHARS = 8000;

/**
 * Read the result rows for a run, newest item first. Tenant-filtered by the
 * active scope via chSelect (throws if unscoped). Ordered so a caller can
 * render the drill-down deterministically.
 *
 * The read is bounded. It returns at most EVAL_ITEM_RESULTS_MAX_ROWS rows, and
 * it truncates `output` and `rationale` to EVAL_ITEM_TEXT_MAX_CHARS characters
 * each. A caller that needs every row of a larger run needs a paginated reader.
 */
export async function selectEvalItemResults(
  runId: string,
): Promise<EvalItemResultRow[]> {
  const res = await chSelect<
    Omit<EvalItemResultRow, "cost_usd_micros"> & {
      // ClickHouse's JSON format serialises Int64 as a string to protect JS
      // precision; every other numeric column here is 32-bit and arrives as a
      // number. Uncoerced, this string flowed into eval.run.get's output and
      // failed the capability's own schema ("Expected number, received
      // string" at results[].costUsdMicros) — the rollup selector below
      // already coerces for exactly this reason.
      cost_usd_micros: string | number;
    }
  >({
    query: `
      SELECT
        run_id, dataset_id, item_id, target_kind, model, judge_model,
        score, correctness, faithfulness, passed,
        latency_ms, input_tokens, output_tokens, cost_usd_micros,
        status, error_class,
        substringUTF8(output, 1, {textMax:UInt32}) AS output,
        substringUTF8(rationale, 1, {textMax:UInt32}) AS rationale
      FROM eval_item_results
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND run_id = {runId:String}
      ORDER BY created_at DESC, item_id ASC
      LIMIT {limit:UInt32}
    `,
    params: {
      runId,
      limit: EVAL_ITEM_RESULTS_MAX_ROWS,
      textMax: EVAL_ITEM_TEXT_MAX_CHARS,
    },
  });
  return res.data.map((row) => ({
    ...row,
    cost_usd_micros: Number(row.cost_usd_micros),
  }));
}

/** Per-run cost + token rollup (in the ClickHouse-native micros / token units). */
export interface EvalRunCostRollup {
  costUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Roll up cost and token totals per run across a set of runs, in a single
 * grouped scan of eval_item_results. Tenant-filtered by the active scope via
 * chSelect (throws if unscoped). Returns a Map keyed by run_id; runs with no
 * result rows are simply absent from the map (callers default them to zero).
 * No-ops to an empty map on an empty input array.
 */
export async function selectEvalRunCostRollup(
  runPublicIds: readonly string[],
): Promise<Map<string, EvalRunCostRollup>> {
  const rollup = new Map<string, EvalRunCostRollup>();
  if (runPublicIds.length === 0) return rollup;
  const res = await chSelect<{
    run_id: string;
    cost_usd_micros: string | number;
    input_tokens: string | number;
    output_tokens: string | number;
  }>({
    query: `
      SELECT
        run_id,
        SUM(cost_usd_micros) AS cost_usd_micros,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens
      FROM eval_item_results
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND run_id IN {runIds:Array(String)}
      GROUP BY run_id
    `,
    params: { runIds: runPublicIds },
  });
  for (const row of res.data) {
    rollup.set(row.run_id, {
      costUsdMicros: Number(row.cost_usd_micros),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    });
  }
  return rollup;
}
