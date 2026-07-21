import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphStats } from "@oxagen/oxagen/contracts/graph.stats";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

export const graphStatsHandler: CapabilityHandler<typeof graphStats> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;

  let nodeCount = 0;
  let edgeCount = 0;
  let inferredEdgeCount = 0;
  let sourceCount = 0;
  let lastModifiedAt: string = new Date(0).toISOString();
  let nodesByLabel: Record<string, number> | undefined;
  let edgesByType: Record<string, number> | undefined;
  let growth: GraphStatsGrowth | undefined;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      // These independent reads run SEQUENTIALLY on the one scoped session, NOT
      // via Promise.all(). scopedSession() hands back a single Neo4j session, and
      // a session can only have one query (auto-commit transaction) in flight at a
      // time — firing several session.run() calls concurrently throws Neo4jError
      // "Queries cannot be run directly on a session with an open transaction"
      // (the regression #303 introduced when it "parallelised" these). True
      // parallelism would need a separate session per query; these counts are
      // cheap, so sequential reuse of one session is the correct, simpler fix.
      const results: Array<Awaited<ReturnType<typeof session.run>>> = [];
      results.push(
        await session.run(
          `MATCH (n:GraphNode)
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
             AND n.is_system = false
           RETURN count(n) AS nodeCount,
                  count(DISTINCT n.sourceId) AS sourceCount`,
          { orgId, workspaceId },
        ),
      );
      results.push(
        await session.run(
          `MATCH (n:GraphNode)-[r]->(m:GraphNode)
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
             AND m.orgId = $orgId AND m.workspaceId = $workspaceId
             AND n.is_system = false
             AND m.is_system = false
           RETURN count(r) AS edgeCount,
                  count(CASE WHEN r.inferred = true THEN 1 END) AS inferredEdgeCount`,
          { orgId, workspaceId },
        ),
      );
      results.push(
        await session.run(
          `MATCH (n:GraphNode)
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
             AND n.is_system = false
           RETURN max(coalesce(n.updatedAt, n.createdAt)) AS lastModifiedAt`,
          { orgId, workspaceId },
        ),
      );

      if (input.includeByType) {
        results.push(
          await session.run(
            `MATCH (n:GraphNode)
             WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
               AND n.is_system = false
             RETURN n.label AS label, count(n) AS count`,
            { orgId, workspaceId },
          ),
        );
        results.push(
          await session.run(
            `MATCH (n:GraphNode)-[r]->(m:GraphNode)
             WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
               AND m.orgId = $orgId AND m.workspaceId = $workspaceId
               AND n.is_system = false
               AND m.is_system = false
             RETURN type(r) AS edgeType, count(r) AS count`,
            { orgId, workspaceId },
          ),
        );
      }

      // Node-creation growth block (opt-in). Runs SEQUENTIALLY on the same
      // scoped session as everything above — NOT via Promise.all() — for the
      // exact reason documented at the top of this try{}: one Neo4j session
      // permits only one in-flight query. GraphNode.createdAt is a Neo4j
      // temporal DateTime (every write site sets `n.createdAt = datetime()` —
      // see graph.node.upsert.ts and ingestion/upsert-entity.ts), so we compare
      // against `datetime($threshold)` (DateTime-vs-DateTime, never a raw
      // string — a String/DateTime comparison is null in Cypher) and bucket by
      // `date(n.createdAt)`, which yields the UTC calendar day. Nodes missing
      // createdAt are skipped by the IS NOT NULL guard. We fetch the last 14 UTC
      // days grouped per-day and derive today/yesterday/thisWeek/lastWeek from
      // that single result set in JS — one extra query, not five.
      if (input.includeGrowth) {
        // Threshold = start of the 14th-oldest UTC day (00:00:00.000Z), i.e.
        // 13 days before the start of today, so today plus the prior 13 days
        // are all in range (14 calendar days total).
        const windowStart = startOfUtcDay(new Date(), -13);
        const growthResult = await session.run(
          `MATCH (n:GraphNode)
           WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
             AND n.is_system = false
             AND n.createdAt IS NOT NULL
             AND n.createdAt >= datetime($windowStart)
           RETURN toString(date(n.createdAt)) AS day, count(n) AS count`,
          { orgId, workspaceId, windowStart: windowStart.toISOString() },
        );
        const perDay = new Map<string, number>();
        for (const rec of growthResult.records) {
          const day = rec.get("day") as string | null;
          if (day != null) perDay.set(day, toNumber(rec.get("count")));
        }
        growth = buildGrowth(perDay, new Date());
      }

      const countRec = results[0]!.records[0];
      nodeCount = toNumber(countRec?.get("nodeCount"));
      sourceCount = toNumber(countRec?.get("sourceCount"));

      const edgeRec = results[1]!.records[0];
      edgeCount = toNumber(edgeRec?.get("edgeCount"));
      inferredEdgeCount = toNumber(edgeRec?.get("inferredEdgeCount"));

      const modified = results[2]!.records[0]?.get("lastModifiedAt") as unknown;
      if (modified != null) {
        lastModifiedAt = String(modified);
      }

      if (input.includeByType && results[3] && results[4]) {
        nodesByLabel = {};
        for (const record of results[3].records) {
          const label = record.get("label") as string | null;
          if (label != null)
            nodesByLabel[label] = toNumber(record.get("count"));
        }

        edgesByType = {};
        for (const record of results[4].records) {
          const edgeType = record.get("edgeType") as string | null;
          if (edgeType != null)
            edgesByType[edgeType] = toNumber(record.get("count"));
        }
      }
    } finally {
      await session.close();
    }
  });

  logger.info(
    {
      nodeCount,
      edgeCount,
      inferredEdgeCount,
      sourceCount,
      includeByType: input.includeByType,
      includeGrowth: input.includeGrowth,
      orgId,
      workspaceId,
    },
    "graph.stats: computed graph statistics",
  );

  if (input.includeGrowth && growth) {
    logger.info(
      {
        nodesToday: growth.nodesToday,
        nodesYesterday: growth.nodesYesterday,
        nodesThisWeek: growth.nodesThisWeek,
        nodesLastWeek: growth.nodesLastWeek,
        dailyDays: growth.daily.length,
        orgId,
        workspaceId,
      },
      "graph.stats: computed node-creation growth",
    );
  }

  const output = {
    nodeCount,
    edgeCount,
    inferredEdgeCount,
    sourceCount,
    nodesByLabel,
    edgesByType,
    lastModifiedAt,
    ...(growth ? { growth } : {}),
  };

  // On the app (chat) surface, attach a render directive so the in-app agent
  // displays the stat boxes inline via the "graph-stats" chat component. API and
  // MCP consumers get the plain JSON (the optional field is simply absent).
  if (ctx.surface === "app") {
    return {
      ...output,
      render: { componentId: "graph-stats", props: { ...output } },
    };
  }

  return output;
};

interface GraphStatsDailyRow {
  day: string;
  count: number;
}

interface GraphStatsGrowth {
  nodesToday: number;
  nodesYesterday: number;
  nodesThisWeek: number;
  nodesLastWeek: number;
  daily: GraphStatsDailyRow[];
}

/**
 * Start of a UTC calendar day, offset by `dayOffset` days (negative = earlier).
 * Always 00:00:00.000Z, so callers get stable UTC day boundaries independent of
 * the server's local timezone.
 */
function startOfUtcDay(now: Date, dayOffset = 0): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + dayOffset,
      0,
      0,
      0,
      0,
    ),
  );
}

/** UTC calendar day (YYYY-MM-DD) for the start-of-day offset from `now`. */
function utcDayKey(now: Date, dayOffset = 0): string {
  return startOfUtcDay(now, dayOffset).toISOString().slice(0, 10);
}

/**
 * Assemble the growth block from a per-UTC-day count map (as returned by the
 * daily Cypher grouping). Produces a zero-filled ascending 14-day `daily` array
 * and derives the today / yesterday / this-week / last-week buckets from the
 * same day counts — so a single query backs all five outputs.
 *
 * Week semantics (matching the contract):
 *   - thisWeek  = last 7 UTC days rolling, INCLUDING today (offsets 0..-6)
 *   - lastWeek  = the 7 UTC days before that (offsets -7..-13)
 */
function buildGrowth(perDay: Map<string, number>, now: Date): GraphStatsGrowth {
  const daily: GraphStatsDailyRow[] = [];
  // Oldest (offset -13) → newest (offset 0), ascending.
  for (let offset = -13; offset <= 0; offset += 1) {
    const day = utcDayKey(now, offset);
    daily.push({ day, count: perDay.get(day) ?? 0 });
  }

  const countFor = (offset: number): number =>
    perDay.get(utcDayKey(now, offset)) ?? 0;

  const nodesToday = countFor(0);
  const nodesYesterday = countFor(-1);

  let nodesThisWeek = 0;
  for (let offset = 0; offset >= -6; offset -= 1)
    nodesThisWeek += countFor(offset);

  let nodesLastWeek = 0;
  for (let offset = -7; offset >= -13; offset -= 1)
    nodesLastWeek += countFor(offset);

  return { nodesToday, nodesYesterday, nodesThisWeek, nodesLastWeek, daily };
}

/**
 * Normalise Neo4j integer columns (plain number, bigint, or {low, high}) to a
 * JS number.
 */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (
    value != null &&
    typeof value === "object" &&
    "low" in value &&
    typeof (value as { low: unknown }).low === "number"
  ) {
    return (value as { low: number }).low;
  }
  return 0;
}
