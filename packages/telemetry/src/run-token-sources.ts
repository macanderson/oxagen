/**
 * run-token-sources.ts — what a run's model calls spent on tool definitions,
 * context frames, and steering (spec §12.6, #4493). The spend rollup writes
 * the three sums into `cost.run_totals`.
 *
 * The recorder measures the three sources on each proxied `llm_call` frame
 * (`tool_definition_tokens`, `context_frame_tokens`, `steering_tokens`). This
 * read sums them over the calls the rollup prices, by the predicate
 * `readModelCallFrames` in ./cost-frames.ts prices them by: a token-bearing
 * source, no duplicate stamp, and a model. Each call counts once, so a source
 * is summed once per call.
 *
 * Null means absent, never zero. A column is null in the result when no
 * priced call of the run carried it, which is the case for every run the
 * proxy did not see, for every ledger run, and for `context_frame_tokens` on
 * Claude Code today. A run whose measured calls reported 0 reads 0.
 *
 * It lives here rather than in @oxagen/billing because only this package and
 * the database packages may open the ClickHouse client, and the rollup job
 * has no tenant scope for `chSelect`.
 */
import {
  LLM_CALL_DUPLICATE_OF_ATTR,
  LLM_CALL_TOKEN_SOURCES,
} from "@oxagen/tacho";
import { clickhouse } from "./clickhouse";
import type { FrameRunRef } from "./cost-frames";

/** The three token sources summed over one run's priced model calls. */
export interface RunTokenSources {
  toolDefinitionTokens: number | null;
  contextFrameTokens: number | null;
  steeringTokens: number | null;
}

/** A run with no measured call: every source absent. */
export const NO_RUN_TOKEN_SOURCES: RunTokenSources = Object.freeze({
  toolDefinitionTokens: null,
  contextFrameTokens: null,
  steeringTokens: null,
});

/** The `tacho_events` column behind each member, in select order. */
const SOURCE_COLUMNS = [
  ["toolDefinitionTokens", "tool_definition_tokens"],
  ["contextFrameTokens", "context_frame_tokens"],
  ["steeringTokens", "steering_tokens"],
] as const;

/**
 * The sessions the read names: the caller's list with the root always in it,
 * the rule `runSessions` in ./cost-frames.ts applies to the frame reads.
 */
function sessionsOf(run: {
  rootSessionUuid: string;
  sessionUuids: readonly string[];
}): string[] {
  return run.sessionUuids.includes(run.rootSessionUuid)
    ? [...run.sessionUuids]
    : [run.rootSessionUuid, ...run.sessionUuids];
}

/** A sum and a count as ClickHouse returns them, quoted when 64-bit. */
type Figure = string | number | null | undefined;

/** The sum when at least one call carried the column, else null. */
function sourceSum(sum: Figure, calls: Figure): number | null {
  if (calls === null || calls === undefined || Number(calls) === 0) {
    return null;
  }
  return Number(sum ?? 0);
}

/**
 * The three sources summed over one run's priced model calls. A ledger run
 * reads nothing and returns {@link NO_RUN_TOKEN_SOURCES}: the gateway does not
 * measure the sources. Throws on a degraded store, as the frame reads do, so
 * the rollup job retries rather than writing nulls over measured sums.
 */
export async function readRunTokenSources(args: {
  orgId: string;
  workspaceId: string;
  run: FrameRunRef;
}): Promise<RunTokenSources> {
  const run = args.run;
  if (run.kind === "ledger") return { ...NO_RUN_TOKEN_SOURCES };

  const selected = SOURCE_COLUMNS.flatMap(([, column]) => [
    `toUInt64(coalesce(sum(${column}), 0)) AS ${column}`,
    `count(${column}) AS ${column}_calls`,
  ]).join(",\n        ");
  const result = await clickhouse().query({
    query: `
      SELECT
        ${selected}
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND root_session_uuid = {rootSessionUuid:UUID}
        AND session_uuid IN {sessionUuids:Array(UUID)}
        AND kind = 'llm_call'
        AND source IN {sources:Array(String)}
        AND attrs[{duplicateAttr:String}] = ''
        AND model != ''
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      rootSessionUuid: run.rootSessionUuid,
      sessionUuids: sessionsOf(run),
      sources: LLM_CALL_TOKEN_SOURCES,
      duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
    },
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<Record<string, Figure>>;
  const row = rows[0];
  if (row === undefined) return { ...NO_RUN_TOKEN_SOURCES };
  const sources = { ...NO_RUN_TOKEN_SOURCES };
  for (const [member, column] of SOURCE_COLUMNS) {
    sources[member] = sourceSum(row[column], row[`${column}_calls`]);
  }
  return sources;
}
