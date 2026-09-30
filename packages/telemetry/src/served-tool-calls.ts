import { chInsert, chSelect } from "./tenant";

// A wrapped agent's calls to a published server's tools (ADR-234, #4678), in
// the append-only `served_tool_calls` table (migration 0037).
//
// The served tools in apps/mcp write one row per call through
// recordServedToolCall, next to the governed-action meter. MCP Studio's tool
// panel reads readServedToolFeedback for one server: per tool, the calls, the
// schema rejections, the error results, and the retries.
//
// org_id and workspace_id are stamped by chInsert from the active tenant
// scope, and chSelect filters every read on both, so one workspace never reads
// another's calls. Callers run inside runInTenantScope.

/** The table the rows land in. */
export const SERVED_TOOL_CALLS_TABLE = "served_tool_calls";

/** How the gateway metered a call. The served tools' MeterOutcome. */
export const SERVED_CALL_OUTCOMES = ["allowed", "denied", "parked", "failed"] as const;
export type ServedCallOutcome = (typeof SERVED_CALL_OUTCOMES)[number];

/**
 * Why a call did not do what the agent asked, when the tool is the reason.
 * A refusal by policy, billing, or the route has no problem: it says nothing
 * about the tool.
 */
export const SERVED_CALL_PROBLEMS = ["schema_rejected", "error_result"] as const;
export type ServedCallProblem = (typeof SERVED_CALL_PROBLEMS)[number];

/**
 * One call, as the table stores it. The tenant columns are absent because
 * chInsert stamps them from the scope and overwrites anything a caller sends.
 */
export interface ServedToolCallRow {
  /** The server's name in the published manifest: billing. */
  server: string;
  /** The full tool name: billing__create_refund. */
  tool: string;
  /** `tse_...`, or "" when the request named no tacho session. */
  run_public_id: string;
  outcome: ServedCallOutcome;
  /** "" when the tool is not why the call failed. */
  problem: ServedCallProblem | "";
  /** RFC 3339. */
  created_at: string;
}

/** Append one call. Throws when ClickHouse refuses the insert; the caller decides whether that stops anything. */
export async function recordServedToolCall(row: ServedToolCallRow): Promise<void> {
  await chInsert(SERVED_TOOL_CALLS_TABLE, [row as unknown as Record<string, unknown>]);
}

/** What agents' calls said about one tool over the window. */
export interface ServedToolFeedback {
  /** The full tool name: billing__create_refund. */
  tool: string;
  /**
   * Calls that reached the tool check: allowed or failed, and a denied call
   * whose arguments Cedar could not read. Other denied calls and parked calls
   * are left out.
   */
  calls: number;
  /** Calls the tool's input schema refused. */
  schemaRejections: number;
  /** Calls the tool ran and answered with an error result. */
  errorResults: number;
  /**
   * Calls a run made to the tool after an earlier call to it in the same run
   * had a problem. A call with no run is never a retry.
   */
  retries: number;
}

export interface ReadServedToolFeedbackArgs {
  /** The server's name in the published manifest. */
  server: string;
  /** Trailing window in days: calls newer than now() - windowDays. */
  windowDays: number;
}

/** Raw JSON shapes. ClickHouse answers UInt64 as a string. */
interface RawToolTotals {
  tool: string;
  calls: string | number;
  schema_rejections: string | number;
  error_results: string | number;
}

interface RawRunCalls {
  tool: string;
  calls: string | number;
  first_problem: string | number;
}

/** The filter both reads share: one server, the calls that reached the tool check, the window. */
const WINDOW_FILTER = `
        WHERE org_id = {orgId:UUID}
          AND workspace_id = {workspaceId:UUID}
          AND server = {server:String}
          AND (outcome IN ('allowed', 'failed') OR problem != '')
          AND created_at >= now() - toIntervalDay({windowDays:UInt32})`;

/**
 * Per tool of one server in the active workspace, over the window, sorted by
 * tool name. A tool with no call in the window has no row.
 *
 * Two single-table reads, because chSelect admits nothing wider. The first
 * counts calls, schema rejections, and error results per tool. The second
 * reads only the runs that had a problem: for each (tool, run) it sorts the
 * calls by time and finds the first one with a problem, and every call after
 * it is a retry. A call denied by policy or parked for approval never reached
 * the tool, so it is neither a call nor a retry. A denial with a problem is
 * the agent's arguments failing, so it counts.
 */
export async function readServedToolFeedback(
  args: ReadServedToolFeedbackArgs,
): Promise<ServedToolFeedback[]> {
  const params = {
    server: args.server,
    windowDays: Math.max(0, Math.floor(args.windowDays)),
  };
  const [totals, runs] = await Promise.all([
    chSelect<RawToolTotals>({
      query: `
      SELECT
        tool                                  AS tool,
        count()                               AS calls,
        countIf(problem = 'schema_rejected')  AS schema_rejections,
        countIf(problem = 'error_result')     AS error_results
      FROM ${SERVED_TOOL_CALLS_TABLE}${WINDOW_FILTER}
      GROUP BY tool
      ORDER BY tool
    `,
      params,
    }),
    chSelect<RawRunCalls>({
      query: `
      SELECT
        tool     AS tool,
        count()  AS calls,
        indexOf(
          arrayMap(call -> tupleElement(call, 2), arraySort(groupArray((created_at, problem != '')))),
          1
        )        AS first_problem
      FROM ${SERVED_TOOL_CALLS_TABLE}${WINDOW_FILTER}
          AND run_public_id != ''
      GROUP BY tool, run_public_id
      HAVING countIf(problem != '') > 0
    `,
      params,
    }),
  ]);

  const retries = new Map<string, number>();
  for (const run of runs.data) {
    // first_problem is the 1-based position of the first call with a problem.
    const after = Number(run.calls) - Number(run.first_problem);
    retries.set(run.tool, (retries.get(run.tool) ?? 0) + Math.max(0, after));
  }
  return totals.data.map((r) => ({
    tool: r.tool,
    calls: Number(r.calls),
    schemaRejections: Number(r.schema_rejections),
    errorResults: Number(r.error_results),
    retries: retries.get(r.tool) ?? 0,
  }));
}
