import { TACHO_EVENTS_TABLE } from "./tacho-events-ddl";
import { chSelect } from "./tenant";

/**
 * One run's `steering.manifest` frame, counted: how many published records
 * the assembler included in what the agent read and how many it cut. Steers
 * the host delivered beside the prefix are items too, so the counts read
 * `items` by kind rather than the manifest's own `included`, which adds them.
 */
interface SteeringDeliveryRow {
  sessionUuid: string;
  /** ClickHouse DateTime64 text: when the host sealed the frame. */
  ts: string;
  harness: string;
  agentKey: string;
  recordsIncluded: number;
  recordsCut: number;
  /** Cut for want of room: the count an operator raises the budget for. */
  recordsCutForBudget: number;
  budgetTokens: number;
  spentTokens: number;
}

/** A record cut from every sampled manifest in which it was a candidate. */
interface UndeliveredRecordRow {
  recordId: string;
  /** Runs whose manifest cut it. */
  runs: number;
  /** The reason the newest of those manifests gave. */
  lastReason: string;
  /** ClickHouse DateTime64 text. */
  lastSeen: string;
}

interface RawSteeringDeliveryRow {
  session_uuid: string;
  sealed_at: string;
  harness: string;
  agent_key: string;
  included_ids: string[];
  cut_ids: string[];
  cut_reasons: string[];
  budget_tokens: string | number;
  spent_tokens: string | number;
}

/** Manifests read per call: the pool the undelivered records come from. */
const STEERING_MANIFEST_SCAN = 2000;

/** ClickHouse DateTime64 params want a space-separated, Z-less string. */
function chDateTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/**
 * The window's manifests, newest first, one per session (the newest, if a
 * session sealed more than one), as record ids by outcome. The table is keyed
 * on (org, workspace, session, seq) and partitioned by the month of
 * `received_at` (#4297), so the `ts` bound picks the window and the
 * `received_at` bound keeps the read to the months around it rather than the
 * tenant's whole history. A manifest stamped in the window reached the
 * control plane no earlier than a day before it opened, allowing the host's
 * clock a day's lead, and a late one is still read. One SELECT over one
 * table, because chSelect admits nothing more.
 */
const MANIFESTS_IN_WINDOW = `
  SELECT session_uuid,
    toString(argMax(ts, seq)) AS sealed_at,
    argMax(harness, seq) AS harness,
    argMax(agent_key, seq) AS agent_key,
    argMax(body, seq) AS manifest,
    arrayFilter(i -> JSONExtractString(i, 'kind') = 'record',
      JSONExtractArrayRaw(manifest, 'items')) AS records,
    arrayMap(i -> JSONExtractString(i, 'id'),
      arrayFilter(i -> JSONExtractString(i, 'outcome') = 'included', records)) AS included_ids,
    arrayMap(i -> JSONExtractString(i, 'id'),
      arrayFilter(i -> JSONExtractString(i, 'outcome') = 'cut', records)) AS cut_ids,
    arrayMap(i -> JSONExtractString(i, 'reason'),
      arrayFilter(i -> JSONExtractString(i, 'outcome') = 'cut', records)) AS cut_reasons,
    JSONExtractUInt(manifest, 'budget_tokens') AS budget_tokens,
    JSONExtractUInt(manifest, 'spent_tokens') AS spent_tokens
  FROM ${TACHO_EVENTS_TABLE} FINAL
  WHERE org_id = {orgId:UUID}
    AND workspace_id = {workspaceId:UUID}
    AND kind = 'steering.manifest'
    AND chain_verified = 1
    AND ts >= {since:DateTime64(3)}
    AND ts < {until:DateTime64(3)}
    AND received_at >= {since:DateTime64(3)} - INTERVAL 1 DAY
  GROUP BY session_uuid
  ORDER BY max(ts) DESC, session_uuid
  LIMIT {scan:UInt32}
`;

/**
 * The newest `limit` runs of the window with their record counts, and the
 * records that manifests in the window cut and none included: the ones no
 * agent received. Reads at most STEERING_MANIFEST_SCAN manifests.
 * Tenant-filtered by the ambient scope through chSelect.
 */
export async function selectSteeringDeliveries(args: {
  fromMs: number;
  toMs: number;
  limit: number;
}): Promise<{
  runs: SteeringDeliveryRow[];
  undelivered: UndeliveredRecordRow[];
  scanned: number;
  truncated: boolean;
}> {
  const res = await chSelect<RawSteeringDeliveryRow>({
    query: MANIFESTS_IN_WINDOW,
    params: {
      since: chDateTime(args.fromMs),
      until: chDateTime(args.toMs),
      scan: STEERING_MANIFEST_SCAN + 1,
    },
  });
  const rows = res.data.slice(0, STEERING_MANIFEST_SCAN);
  return {
    scanned: rows.length,
    truncated: res.data.length > STEERING_MANIFEST_SCAN,
    runs: rows.slice(0, args.limit).map((r) => ({
      sessionUuid: r.session_uuid,
      ts: r.sealed_at,
      harness: r.harness,
      agentKey: r.agent_key,
      recordsIncluded: r.included_ids.length,
      recordsCut: r.cut_ids.length,
      recordsCutForBudget: r.cut_reasons.filter((x) => x === "budget").length,
      budgetTokens: Number(r.budget_tokens),
      spentTokens: Number(r.spent_tokens),
    })),
    undelivered: undeliveredRecords(rows).slice(0, args.limit),
  };
}

/** Records some manifest cut and no manifest included, most-cut first. */
function undeliveredRecords(
  rows: readonly Pick<
    RawSteeringDeliveryRow,
    "sealed_at" | "included_ids" | "cut_ids" | "cut_reasons"
  >[],
): UndeliveredRecordRow[] {
  const delivered = new Set(rows.flatMap((r) => r.included_ids));
  const byId = new Map<string, UndeliveredRecordRow>();
  for (const r of rows) {
    const seenInRun = new Set<string>();
    r.cut_ids.forEach((id, n) => {
      if (seenInRun.has(id)) return;
      seenInRun.add(id);
      if (delivered.has(id)) return;
      const seen = byId.get(id);
      if (!seen) {
        byId.set(id, {
          recordId: id,
          runs: 1,
          lastReason: r.cut_reasons[n] ?? "",
          lastSeen: r.sealed_at,
        });
        return;
      }
      seen.runs += 1;
      if (r.sealed_at > seen.lastSeen) {
        seen.lastSeen = r.sealed_at;
        seen.lastReason = r.cut_reasons[n] ?? "";
      }
    });
  }
  return [...byId.values()].sort(
    (a, b) => b.runs - a.runs || a.recordId.localeCompare(b.recordId),
  );
}
