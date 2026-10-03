/**
 * context-window-frames.ts — the request windows a wrapped run recorded, for
 * the cost rollup (#5341, ADR-200).
 *
 * The tacho model proxy writes each request's window on its `llm_call` frame
 * as the `oxagen.window` attribute, beside the usage the vendor reported. The
 * proxy seals one sighting per request, so each windowed row is one request.
 * This read returns those rows for every chain of one run, in the
 * `TachoModelCallRow` shape `tachoContextWindow` in `@oxagen/run-ledger`
 * decodes, so the rollup and `get_run_context` read a window the same way.
 *
 * `get_run_context` reads one session through `chSelect`, under the caller's
 * tenant scope, and keeps every `llm_call` and manifest row because it counts
 * the calls with no window too. The rollup runs outside a tenant scope, reads
 * every chain of the run, and needs only the windowed rows. A run family too
 * long to name in the URL reads its chains through a subquery
 * (`runSessionsFilter`), which the `chSelect` fence refuses. So this read
 * names the organization, the workspace and the run's root in its predicates,
 * as the other rollup reads in ./cost-frames.ts do.
 */
import {
  CONTEXT_WINDOW_ATTR,
  LLM_CALL_DUPLICATE_OF_ATTR,
} from "@oxagen/recorder";
import { clickhouse } from "./clickhouse";
import { COST_FRAME_QUERY_SETTINGS, runSessionsFilter } from "./cost-frames";

/**
 * One windowed `llm_call` row. The members match `TachoModelCallRow` in
 * `@oxagen/run-ledger`, which this package does not depend on. `attrs` holds
 * the window and the duplicate stamp only. `body` is empty, since a model
 * call's body adds nothing the typed columns do not carry.
 */
export interface TachoWindowFrameRow {
  seq: number;
  kind: "llm_call";
  attrs: Readonly<Record<string, string>>;
  model: string;
  provider: string;
  /** The vendor's request id; empty when it sent none. */
  requestId: string;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  body: "";
}

interface WindowFrameDbRow {
  seq: string | number;
  window_attr: string;
  duplicate_of: string;
  model: string;
  provider: string;
  request_id: string;
  input_tokens: string | number | null;
  cache_read_tokens: string | number | null;
  cache_creation_tokens: string | number | null;
}

/** Rows handed to the consumer at a time. */
const WINDOW_FRAME_BATCH = 256;

function nullableCount(value: string | number | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function toWindowFrameRow(row: WindowFrameDbRow): TachoWindowFrameRow {
  return {
    seq: Number(row.seq),
    kind: "llm_call",
    attrs: {
      [CONTEXT_WINDOW_ATTR]: row.window_attr,
      ...(row.duplicate_of === ""
        ? {}
        : { [LLM_CALL_DUPLICATE_OF_ATTR]: row.duplicate_of }),
    },
    model: row.model,
    provider: row.provider,
    requestId: row.request_id,
    inputTokens: nullableCount(row.input_tokens),
    cacheReadTokens: nullableCount(row.cache_read_tokens),
    cacheCreationTokens: nullableCount(row.cache_creation_tokens),
    body: "",
  };
}

/**
 * Every `llm_call` row of one wrapped run that carries a window, oldest
 * first, handed to `consume` in batches. The run's chains are named by the
 * table's sort key (`runSessionsFilter`, #4103), and the root and workspace
 * predicates stay, as in `readModelCallFrames`. Throws on a degraded store:
 * the rollup retries rather than writing a composition from missing frames.
 */
export async function readTachoWindowFrames(
  args: {
    orgId: string;
    workspaceId: string;
    rootSessionUuid: string;
    /** The run's sessions, root first. The root is read whether listed or not. */
    sessionUuids: readonly string[];
  },
  consume: (rows: TachoWindowFrameRow[]) => Promise<void>,
): Promise<void> {
  const sessions = runSessionsFilter(
    args.sessionUuids.includes(args.rootSessionUuid)
      ? args.sessionUuids
      : [args.rootSessionUuid, ...args.sessionUuids],
  );
  const result = await clickhouse().query({
    query: `
      SELECT
        seq,
        attrs[{windowAttr:String}] AS window_attr,
        attrs[{duplicateAttr:String}] AS duplicate_of,
        model,
        provider,
        request_id,
        input_tokens,
        cache_read_tokens,
        cache_creation_tokens
      FROM tacho_events FINAL
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND root_session_uuid = {rootSessionUuid:UUID}
        AND ${sessions.sql}
        AND kind = 'llm_call'
        AND attrs[{windowAttr:String}] != ''
      ORDER BY ts, session_uuid, seq
    `,
    query_params: {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      rootSessionUuid: args.rootSessionUuid,
      ...sessions.params,
      windowAttr: CONTEXT_WINDOW_ATTR,
      duplicateAttr: LLM_CALL_DUPLICATE_OF_ATTR,
    },
    format: "JSONEachRow",
    clickhouse_settings: COST_FRAME_QUERY_SETTINGS,
  });
  let batch: TachoWindowFrameRow[] = [];
  try {
    for await (const rows of result.stream()) {
      for (const row of rows) {
        batch.push(toWindowFrameRow(row.json() as WindowFrameDbRow));
        if (batch.length === WINDOW_FRAME_BATCH) {
          await consume(batch);
          batch = [];
        }
      }
    }
    if (batch.length > 0) await consume(batch);
  } finally {
    result.close();
  }
}
