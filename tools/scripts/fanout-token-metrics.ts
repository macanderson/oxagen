/**
 * fanout-token-metrics.ts — before/after measurement for the compact fanout
 * aggregate (docs/specs/graph-mediated-fanout, success metrics section).
 *
 * Compares two windows around a cutover date (default: 2026-07-04, when
 * PR #527 merged) on the ClickHouse telemetry store:
 *
 *   1. aggregate-calls-per-dispatch  — target ≤ 2 median (spec metric 2)
 *   2. result.get fan-back ratio     — guard metric (spec metric 4): calls to
 *      agent.subagent.result.get per dispatched child; alert if > 0.5
 *   3. parent-step input tokens      — avg/p50/p95 input_tokens per LLM step on
 *      chat/agent surfaces (proxy for spec metric 1 — token_usage has no
 *      conversation join, so this is a trend, not an exact per-fanout figure)
 *   4. parent-step latency           — avg/p95 duration_ms on the same steps
 *
 * Usage (repo root):
 *   pnpm metrics:fanout                       # 7 days each side of cutover
 *   pnpm metrics:fanout -- --cutover 2026-07-04 --days 7
 *
 * Requires CLICKHOUSE_* env (reads .env.local via the pnpm script). Read-only.
 */
import { clickhouse, closeClickhouse } from "@oxagen/telemetry";

interface Args {
  cutover: string;
  days: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cutover: "2026-07-04", days: 7 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cutover" && argv[i + 1]) args.cutover = argv[++i]!;
    if (argv[i] === "--days" && argv[i + 1]) args.days = Number(argv[++i]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.cutover))
    throw new Error(`bad --cutover: ${args.cutover}`);
  if (!Number.isFinite(args.days) || args.days <= 0)
    throw new Error(`bad --days: ${args.days}`);
  return args;
}

type Row = Record<string, string | number | null>;

async function select(sql: string): Promise<Row[]> {
  const res = await clickhouse().query({ query: sql, format: "JSONEachRow" });
  return (await res.json()) as Row[];
}

// One window's metrics. `from`/`to` are ISO dates (to exclusive).
async function windowMetrics(from: string, to: string) {
  const range = `created_at >= toDateTime('${from} 00:00:00') AND created_at < toDateTime('${to} 00:00:00')`;

  const [fanout] = await select(`
    SELECT
      countIf(capability_name = 'dispatch_subagent')   AS dispatches,
      countIf(capability_name = 'aggregate_subagents')  AS aggregates,
      countIf(capability_name = 'get_subagent_result') AS result_gets,
      countIf(surface = 'runner' AND parent_message_id IS NOT NULL) AS child_runs
    FROM tool_invocations
    WHERE ${range}
  `);

  const [steps] = await select(`
    SELECT
      count()                            AS llm_steps,
      round(avg(input_tokens))           AS avg_input_tokens,
      round(quantile(0.5)(input_tokens)) AS p50_input_tokens,
      round(quantile(0.95)(input_tokens)) AS p95_input_tokens,
      round(avg(duration_ms))            AS avg_duration_ms,
      round(quantile(0.95)(duration_ms)) AS p95_duration_ms
    FROM token_usage
    WHERE ${range} AND surface IN ('chat', 'agent')
  `);

  // Phase 2 self-healing + peer-read + scaling metrics
  // (docs/specs/graph-mediated-fanout-phase2, success metrics). Reads the
  // `events` rows emitted by agent.lease-sweep and the executor.
  const eventRange = `emitted_at >= toDateTime('${from} 00:00:00') AND emitted_at < toDateTime('${to} 00:00:00')`;
  const [lease] = await select(`
    SELECT
      countIf(event_type = 'agent.lease.expired')   AS lease_expired,
      countIf(event_type = 'agent.task.reclaimed')  AS tasks_reclaimed,
      countIf(event_type = 'agent.lease.expired' AND JSONExtractInt(payload, 'attempts') >= 3) AS failed_at_cap
    FROM events
    WHERE ${eventRange}
      AND event_type IN ('agent.lease.expired', 'agent.task.reclaimed')
  `);

  const [scaling] = await select(`
    SELECT
      count()                                                        AS fanouts_completed,
      round(quantile(0.5)(JSONExtractInt(payload, 'depth')), 2)      AS p50_depth,
      max(JSONExtractInt(payload, 'depth'))                          AS max_depth,
      round(quantile(0.5)(JSONExtractInt(payload, 'descendantCount')), 2) AS p50_descendants,
      max(JSONExtractInt(payload, 'descendantCount'))                AS max_descendants,
      countIf(JSONExtractInt(payload, 'descendantCount') >= 250)     AS descendant_cap_hits
    FROM events
    WHERE ${eventRange}
      AND event_type = 'agent.subagent.fanout.completed'
  `);

  const [siblingReads] = await select(`
    SELECT countIf(capability_name = 'list_subagent_siblings') AS sibling_reads
    FROM tool_invocations
    WHERE ${range}
  `);

  const dispatches = Number(fanout?.dispatches ?? 0);
  const childRuns = Number(fanout?.child_runs ?? 0);
  return {
    from,
    to,
    dispatches,
    aggregatesPerDispatch: dispatches
      ? Number(fanout!.aggregates) / dispatches
      : null,
    resultGetFanBack: childRuns
      ? Number(fanout!.result_gets) / childRuns
      : null,
    siblingReadsPerDispatch: dispatches
      ? Number(siblingReads?.sibling_reads ?? 0) / dispatches
      : null,
    lease_expired: Number(lease?.lease_expired ?? 0),
    tasks_reclaimed: Number(lease?.tasks_reclaimed ?? 0),
    failed_at_cap: Number(lease?.failed_at_cap ?? 0),
    p50_depth: scaling?.p50_depth ?? null,
    max_depth: scaling?.max_depth ?? null,
    p50_descendants: scaling?.p50_descendants ?? null,
    max_descendants: scaling?.max_descendants ?? null,
    descendant_cap_hits: Number(scaling?.descendant_cap_hits ?? 0),
    ...steps,
  };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const { cutover, days } = parseArgs(process.argv.slice(2));
  const before = await windowMetrics(addDays(cutover, -days), cutover);
  const after = await windowMetrics(cutover, addDays(cutover, days));

  console.log(`fanout token metrics — cutover ${cutover}, ±${days}d windows\n`);
  const keys = [
    "dispatches",
    "aggregatesPerDispatch",
    "resultGetFanBack",
    "siblingReadsPerDispatch",
    "lease_expired",
    "tasks_reclaimed",
    "failed_at_cap",
    "p50_depth",
    "max_depth",
    "p50_descendants",
    "max_descendants",
    "descendant_cap_hits",
    "llm_steps",
    "avg_input_tokens",
    "p50_input_tokens",
    "p95_input_tokens",
    "avg_duration_ms",
    "p95_duration_ms",
  ] as const;
  const fmt = (v: unknown) =>
    v === null || v === undefined
      ? "—"
      : typeof v === "number"
        ? String(Math.round(v * 100) / 100)
        : String(v);
  console.log(
    `${"metric".padEnd(24)} ${"before".padStart(12)} ${"after".padStart(12)}`,
  );
  for (const k of keys) {
    console.log(
      `${k.padEnd(24)} ${fmt((before as Row)[k]).padStart(12)} ${fmt((after as Row)[k]).padStart(12)}`,
    );
  }
  console.log(
    "\ntargets: aggregatesPerDispatch ≤ 2 · resultGetFanBack < 0.5 (alert above) · avg_input_tokens trending down on fanout-heavy orgs" +
      "\nphase 2: tasks_reclaimed ≈ lease_expired − failed_at_cap (self-healing working) · reclaim MTTR ≤ 1 sweep interval (5 min, both events land in the same sweep)" +
      "\n         descendant_cap_hits > 0 means the cap is doing work (or is too tight) · failed_at_cap should stay near 0",
  );
  await closeClickhouse();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
