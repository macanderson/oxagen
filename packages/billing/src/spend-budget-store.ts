/**
 * spend-budget-store.ts — the Postgres CRUD for the hard period-to-date spend
 * ceiling (billing.spend_budgets, OXA-1079). All reads/writes go through
 * withTenantDb so RLS (`workspace_nullable`) scopes them: a read inside a
 * workspace scope returns BOTH the org-level ceiling (workspace_id IS NULL) and
 * that workspace's own ceiling.
 *
 * The pure evaluator + types live in ./spend-budget; the kernel gate that calls
 * getScopeBudgets lives in ./spend-budget-gate; the get_spend_budget /
 * set_spend_budget handlers call getSpendBudget / setSpendBudget here.
 */
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { SpendBudget, SpendBudgetPeriod } from "./spend-budget";

type Row = typeof schema.spendBudgets.$inferSelect;

function rowToBudget(row: Row): SpendBudget {
  return {
    scope: row.workspaceId === null ? "org" : "workspace",
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    enabled: row.enabled,
    period: row.period as SpendBudgetPeriod,
    windowDays: row.windowDays,
    limitMicros: BigInt(row.limitMicros),
  };
}

/** A budget row plus its notify watermark — the shape the gate needs to dedup
 *  threshold notifications. */
export interface SpendBudgetRow extends SpendBudget {
  id: string;
  publicId: string;
  notifiedThreshold: number;
  notifiedPeriodStart: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToBudgetRow(row: Row): SpendBudgetRow {
  return {
    ...rowToBudget(row),
    id: row.id,
    publicId: row.publicId,
    notifiedThreshold: row.notifiedThreshold,
    notifiedPeriodStart: row.notifiedPeriodStart,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Every ENABLED ceiling applicable to a workspace invocation: the org-level
 * ceiling (workspace_id IS NULL) and the workspace's own ceiling. Ordered
 * org-first so the gate reports the broader ceiling first. Runs inside the
 * caller's active tenant scope (the kernel gate already holds one).
 */
export async function getScopeBudgets(): Promise<SpendBudgetRow[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select()
      .from(schema.spendBudgets)
      .where(eq(schema.spendBudgets.enabled, true)),
  );
  // RLS already narrows to (org-default OR this workspace); order org-first.
  return rows
    .map(rowToBudgetRow)
    .sort((a, b) => (a.scope === "org" ? 0 : 1) - (b.scope === "org" ? 0 : 1));
}

/**
 * The single ceiling for one scope (org-level when workspaceId is null), or null
 * when none is configured. Used by get_spend_budget and set_spend_budget's
 * read-modify-write.
 */
export async function getSpendBudget(args: {
  workspaceId: string | null;
}): Promise<SpendBudgetRow | null> {
  const rows = await withTenantDb((tx) =>
    tx
      .select()
      .from(schema.spendBudgets)
      .where(
        args.workspaceId === null
          ? isNull(schema.spendBudgets.workspaceId)
          : eq(schema.spendBudgets.workspaceId, args.workspaceId),
      )
      .limit(1),
  );
  const row = rows[0];
  return row ? rowToBudgetRow(row) : null;
}

/** Both scopes for the current tenant: the org ceiling and (if any) the
 *  workspace ceiling — powers the app panel's two-scope view. */
export async function listSpendBudgets(): Promise<SpendBudgetRow[]> {
  const rows = await withTenantDb((tx) =>
    tx.select().from(schema.spendBudgets),
  );
  return rows
    .map(rowToBudgetRow)
    .sort((a, b) => (a.scope === "org" ? 0 : 1) - (b.scope === "org" ? 0 : 1));
}

export interface SetSpendBudgetInput {
  orgId: string;
  /** Null ⇒ set the ORG-LEVEL ceiling; a workspace uuid ⇒ that workspace's. */
  workspaceId: string | null;
  enabled: boolean;
  period: SpendBudgetPeriod;
  /** Required for 'rolling'; must be null for 'monthly' (DB CHECK enforces). */
  windowDays: number | null;
  limitMicros: bigint;
  /** Acting user, for the audit columns. */
  actorUserId: string | null;
}

/**
 * Upsert one scope's ceiling (read-modify-write inside one tenant transaction —
 * the partial unique indexes on (org_id) WHERE workspace_id IS NULL and
 * (workspace_id) make a plain onConflict target awkward, and budgets are set
 * rarely by an admin so the extra round-trip is immaterial). Any write RESETS
 * the notify watermark so a raised ceiling re-notifies from a clean slate.
 */
export async function setSpendBudget(
  input: SetSpendBudgetInput,
): Promise<SpendBudgetRow> {
  const row = await withTenantDb(async (tx) => {
    const existing = (
      await tx
        .select()
        .from(schema.spendBudgets)
        .where(
          input.workspaceId === null
            ? isNull(schema.spendBudgets.workspaceId)
            : eq(schema.spendBudgets.workspaceId, input.workspaceId),
        )
        .limit(1)
    )[0];

    const windowDays = input.period === "rolling" ? input.windowDays : null;

    if (existing) {
      const [updated] = await tx
        .update(schema.spendBudgets)
        .set({
          enabled: input.enabled,
          period: input.period,
          windowDays,
          limitMicros: input.limitMicros,
          notifiedThreshold: 0,
          notifiedPeriodStart: null,
          updatedByUserId: input.actorUserId,
          updatedAt: new Date(),
        })
        .where(eq(schema.spendBudgets.id, existing.id))
        .returning();
      return updated!;
    }

    const [created] = await tx
      .insert(schema.spendBudgets)
      .values({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        enabled: input.enabled,
        period: input.period,
        windowDays,
        limitMicros: input.limitMicros,
        createdByUserId: input.actorUserId,
        updatedByUserId: input.actorUserId,
      })
      .returning();
    return created!;
  });
  return rowToBudgetRow(row);
}

/**
 * Advance the notify watermark for one budget to `threshold` ONLY when it is a
 * new high for the CURRENT period — the conditional UPDATE makes "notify once
 * per threshold per period" correct under concurrency (the row that flips the
 * watermark is the one that sends). Returns true when THIS caller won the flip
 * (and should therefore deliver the notification). Resets the watermark when the
 * period rolled over (notified_period_start ≠ the active period start).
 */
export async function claimBudgetThreshold(args: {
  budgetId: string;
  threshold: number;
  periodStart: Date;
}): Promise<boolean> {
  const affected = await withTenantDb((tx) =>
    tx
      .update(schema.spendBudgets)
      .set({
        notifiedThreshold: args.threshold,
        notifiedPeriodStart: args.periodStart,
      })
      .where(
        and(
          eq(schema.spendBudgets.id, args.budgetId),
          or(
            // Period rolled over → any threshold is new.
            sql`${schema.spendBudgets.notifiedPeriodStart} IS NULL`,
            sql`${schema.spendBudgets.notifiedPeriodStart} <> ${args.periodStart}`,
            // Same period → only a strictly higher threshold is new.
            sql`${schema.spendBudgets.notifiedThreshold} < ${args.threshold}`,
          ),
        ),
      )
      .returning({ id: schema.spendBudgets.id }),
  );
  return affected.length > 0;
}
