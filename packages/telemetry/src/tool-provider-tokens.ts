import { TACHO_EVENTS_TABLE } from "./tacho-events-ddl";
import { chSelect } from "./tenant";

/**
 * The tokens each tool provider's definitions add to a model call, as the
 * recorder last listed them in the workspace (#4537, spec detector 2).
 *
 * A model call's `system_context_parts` lists the parts of its system
 * context (#4493): a tool part carries the MCP server that serves it as
 * `provider`, or `builtin`. The recorder lists them on the first call of each
 * turn and whenever the context changes, so the newest listing that names a
 * provider holds what that provider's definitions cost a request now. A
 * provider an agent stopped loading keeps its last count until the window
 * ages it out.
 */
export interface ToolProviderTokens {
  /** The server name as the harness calls it, `mcp__<provider>__<tool>`. */
  provider: string;
  /** The provider's tool definitions in that listing, summed. */
  tokens: number;
  /** ClickHouse DateTime64 text: the listing's frame. */
  listedAt: string;
}

interface RawProviderRow {
  tool_provider: string;
  tokens: string | number;
  listed_at: string;
}

/** The most providers one read returns. */
const PROVIDER_SCAN = 1000;

/** ClickHouse DateTime64 params want a space-separated, Z-less string. */
function chDateTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Each listing's tool parts, summed per provider, then the newest listing per
 * provider (`LIMIT 1 BY`). One SELECT over one table, because chSelect admits
 * nothing more, so the parts unroll with `arrayJoin` in the select list. The
 * alias `part` names that one `arrayJoin`, so the provider and the tokens
 * read the same part. The provider's alias is `tool_provider`, because
 * `tacho_events` has a `provider` column of its own (the model's provider),
 * and an alias that shadows a column reads differently across ClickHouse's
 * analyzers. The `received_at` bound keeps the read to the months
 * around the window, as `selectSteeringDeliveries` does (#4297).
 */
const PROVIDER_TOKENS_IN_WINDOW = `
  SELECT
    tupleElement(arrayJoin(arrayMap(
      p -> (JSONExtractString(p, 'provider'), JSONExtractUInt(p, 'tokens')),
      arrayFilter(p -> JSONExtractString(p, 'kind') = 'tool',
        JSONExtractArrayRaw(system_context_parts)))) AS part, 1) AS tool_provider,
    sum(tupleElement(part, 2)) AS tokens,
    toString(max(ts)) AS listed_at
  FROM ${TACHO_EVENTS_TABLE} FINAL
  WHERE org_id = {orgId:UUID}
    AND workspace_id = {workspaceId:UUID}
    AND kind = 'llm_call'
    AND system_context_parts != ''
    AND ts >= {since:DateTime64(3)}
    AND ts < {until:DateTime64(3)}
    AND received_at >= {since:DateTime64(3)} - INTERVAL 1 DAY
  GROUP BY session_uuid, seq, tool_provider
  ORDER BY max(ts) DESC, seq DESC
  LIMIT 1 BY tool_provider
  LIMIT {scan:UInt32}
`;

/**
 * The newest listed token count of every tool provider over [fromMs, toMs).
 * A provider no listing in the window names is absent from the result.
 * Tenant-filtered by the ambient scope through chSelect.
 */
export async function selectToolProviderTokens(args: {
  fromMs: number;
  toMs: number;
}): Promise<ToolProviderTokens[]> {
  const res = await chSelect<RawProviderRow>({
    query: PROVIDER_TOKENS_IN_WINDOW,
    params: {
      since: chDateTime(args.fromMs),
      until: chDateTime(args.toMs),
      scan: PROVIDER_SCAN,
    },
  });
  return res.data
    .filter((r) => r.tool_provider !== "")
    .map((r) => ({
      provider: r.tool_provider,
      tokens: Number(r.tokens),
      listedAt: r.listed_at,
    }));
}
