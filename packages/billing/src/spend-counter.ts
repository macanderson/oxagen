/**
 * spend-counter.ts — the running spend counter the recorders keep for the
 * spend-budget gate (Mission Control spec §12.5; ADR-060 §5; #2820).
 *
 * `billing.spend_counters` holds one row per (org, workspace, UTC day) in
 * micro-USD. Every recorder that prices a model call adds to it in the same
 * breath as it writes the frame: the `@oxagen/ai` gateway after `token_usage`,
 * and the tacho ingest handler inside the transaction that records a batch
 * that carried cost (#3825). The gate (./spend-budget-gate.ts) and the budget
 * panel sum these rows over the ceiling's window in Postgres, so a ClickHouse
 * stall neither zeroes a ceiling nor denies a call.
 *
 * The counter is day-granular. A rolling window that starts mid-day counts
 * the whole of its first day, a bounded over-count of at most one day's
 * spend at the window's tail; a monthly window starts on a day boundary and
 * is exact.
 *
 * Both functions run on the SHARED plane. ADR-042 §2 and ADR-134 keep
 * platform billing there, and a dedicated data plane carries only tenant
 * data. The gate reads through `withSystemDb` with explicit org and
 * workspace predicates, because an org-level ceiling sums every workspace's
 * rows, which a workspace-scoped session could not see.
 *
 * `recordSpend` takes the caller's transaction and joins it when that
 * transaction is on the shared plane: tacho ingest (#3825) and usage
 * settlement pass theirs, so the counter and the batch commit or roll back
 * together. The `tenant_isolation` policy on `billing.spend_counters`
 * admits that write because the row names the transaction's own org and
 * workspace. When the caller's transaction is on an organisation's dedicated
 * plane (#4306), the write opens its own shared-plane transaction instead,
 * so it lands in the counter the gate reads. It runs before the caller
 * commits, so a failed counter write still rolls the caller back. The one
 * gap is a caller whose commit fails after the counter committed: its retry
 * counts the cost again, an over-count that makes the gate stricter.
 */
import {
  ambientPlaneKey,
  schema,
  withSystemDb,
  type Tx,
} from "@oxagen/database";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { inTransaction } from "./internal/in-transaction";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** The plane key `withSystemDb` and a shared-plane `withTenantDb` run under. */
const SHARED_PLANE = "shared";

/** The UTC calendar day of an instant, as `YYYY-MM-DD`. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Add `micros` to the counter for the frame's org, workspace and day. A
 * non-positive amount writes nothing. One INSERT … ON CONFLICT DO UPDATE on
 * the scope-day key, so concurrent recorders add rather than overwrite.
 */
export async function recordSpend(
  args: {
    orgId: string;
    /** Null for a frame outside a workspace. */
    workspaceId: string | null;
    at: Date;
    micros: bigint;
  },
  transaction?: Tx,
): Promise<void> {
  if (args.micros <= 0n) return;
  const workspaceId = args.workspaceId === NIL_UUID ? null : args.workspaceId;
  const run = (tx: Tx) =>
    tx.execute(sql`
      INSERT INTO ${schema.spendCounters} (org_id, workspace_id, day, spent_micros)
      VALUES (${args.orgId}::uuid, ${workspaceId}::uuid, ${utcDay(args.at)}::date, ${args.micros.toString()}::bigint)
      ON CONFLICT (org_id, coalesce(workspace_id, '${sql.raw(NIL_UUID)}'::uuid), day)
      DO UPDATE SET
        spent_micros = ${schema.spendCounters}.spent_micros + EXCLUDED.spent_micros,
        updated_at = now()
    `);
  // The caller's transaction is joined only on the shared plane, where the
  // gate reads. `ambientPlaneKey` names the plane of the innermost seam that
  // opened a transaction, which is the one `transaction` belongs to.
  const joinable =
    transaction !== undefined && (await ambientPlaneKey()) === SHARED_PLANE
      ? transaction
      : undefined;
  // tenancy: global billing counters use the authenticated ingestion caller's orgId and workspaceId.
  await inTransaction(joinable, run, withSystemDb);
}

/**
 * Period-to-date spend (micro-USD) for a scope window, from the counter. An
 * org-level ceiling omits `workspaceId` and sums every row of the org; a
 * workspace ceiling sums the rows that name it. The signature is the gate's
 * `readSpend` dependency, so it replaces the ClickHouse sum in place.
 */
export async function sumSpendCounter(args: {
  orgId: string;
  workspaceId?: string | null;
  periodStart: Date;
  periodEnd: Date;
}): Promise<bigint> {
  const scoped = args.workspaceId != null && args.workspaceId.length > 0;
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        micros: sql<string>`coalesce(sum(${schema.spendCounters.spentMicros}), 0)::text`,
      })
      .from(schema.spendCounters)
      .where(
        and(
          eq(schema.spendCounters.orgId, args.orgId),
          scoped
            ? eq(schema.spendCounters.workspaceId, args.workspaceId as string)
            : undefined,
          gte(schema.spendCounters.day, utcDay(args.periodStart)),
          lte(schema.spendCounters.day, utcDay(args.periodEnd)),
        ),
      ),
  );
  return BigInt(rows[0]?.micros ?? "0");
}
