// run-context.ts: the frames `get_run_context` reads, from the store that
// recorded them (ADR-200).
//
// A wrapped session's windows are its `llm_call` rows in `tacho_events`,
// with the proxy's `oxagen.window` attribute and the usage the vendor
// reported, and its manifests are its `steering.manifest` rows. One read
// takes both kinds in frame order and leaves every other body out, because
// an `llm_call` body adds nothing the typed columns do not carry and a
// manifest's body is the one the assembled panel reads.
import type { TachoModelCallRow } from "@oxagen/run-ledger";
import { chSelect, TACHO_EVENTS_TABLE } from "@oxagen/telemetry";

interface RawModelCallRow {
  seq: string | number;
  kind: string;
  attrs: Record<string, string> | null;
  model: string;
  provider: string;
  request_id: string;
  input_tokens: string | number | null;
  cache_read_tokens: string | number | null;
  cache_creation_tokens: string | number | null;
  body: string;
}

function nullableCount(value: string | number | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * A wrapped session's `llm_call` and `steering.manifest` rows in `seq`
 * order, at most `limit`. Tenant-filtered by the ambient scope through
 * `chSelect`.
 */
export async function readTachoModelCalls(
  sessionUuid: string,
  limit: number,
): Promise<TachoModelCallRow[]> {
  const result = await chSelect<RawModelCallRow>({
    query: `SELECT seq, kind, attrs, model, provider, request_id,
        input_tokens, cache_read_tokens, cache_creation_tokens,
        if(kind = 'steering.manifest', body, '') AS body
      FROM ${TACHO_EVENTS_TABLE} FINAL
      WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}
        AND session_uuid = {sessionUuid:UUID}
        AND kind IN ('llm_call', 'steering.manifest')
      ORDER BY seq ASC
      LIMIT {limit:UInt32}`,
    params: { sessionUuid, limit },
  });
  return result.data.map((row) => ({
    seq: Number(row.seq),
    kind: row.kind,
    attrs: row.attrs ?? undefined,
    model: row.model,
    provider: row.provider,
    requestId: row.request_id,
    inputTokens: nullableCount(row.input_tokens),
    cacheReadTokens: nullableCount(row.cache_read_tokens),
    cacheCreationTokens: nullableCount(row.cache_creation_tokens),
    body: row.body,
  }));
}
