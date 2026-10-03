/**
 * workspace-lane-budget.ts: the customer's own daily budget on each lane of a
 * workspace's model calls (#5426).
 *
 * Billing is pass-through, so this cap is the workspace's control and not the
 * platform's: it applies whoever pays the vendor, the platform key or the
 * organisation's own, and it sits beside the org-level monthly assistant cap
 * (ADR-053 §3), which stays the platform's ceiling.
 *
 * The limit is `workspace.workspaces.settings.dailyBudgetUsd.<lane>`, read
 * through `dailyBudgetUsdOf`, so a setting that cannot be read never refuses
 * a call. The spend is today's row of `billing.spend_counters` for the lane,
 * which the usage outbox adds to as each priced call settles. The gate reads
 * the counter before the call and the recorder adds after it, so a burst of
 * concurrent calls can take a lane a few calls past its limit; the next call
 * is refused. The budget resets at 00:00 UTC.
 *
 * On a read failure the gate fails OPEN, as the credit gate does: a metering
 * blip must not stop the work, and the error log makes a gate that keeps
 * failing open visible.
 */
import { schema, withTenantDb } from "@oxagen/database";
import {
  dailyBudgetUsdOf,
  SPEND_LANE_KEYS,
  SPEND_LANE_LABELS,
  type SpendLane,
} from "@oxagen/oxagen/workspace-budgets";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { sumLaneSpendForDay } from "./spend-counter";

export class WorkspaceBudgetSpentError extends Error {
  readonly code = "workspace_budget_spent" as const;
  readonly lane: SpendLane;
  readonly budgetUsd: number;
  readonly spentUsd: number;

  constructor(lane: SpendLane, budgetUsd: number, spentUsd: number) {
    super(
      `The workspace's daily budget for ${SPEND_LANE_LABELS[lane]} is spent: $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} today. It resets at 00:00 UTC. A workspace owner can raise it in the workspace's settings.`,
    );
    this.name = "WorkspaceBudgetSpentError";
    this.lane = lane;
    this.budgetUsd = budgetUsd;
    this.spentUsd = spentUsd;
  }
}

export interface LaneBudgetStanding {
  lane: SpendLane;
  /** The lane's daily budget in US dollars, or null for no limit. */
  budgetUsd: number | null;
  /** Today's spend on the lane in US dollars. */
  spentUsd: number;
  /** Whether the next call is admitted. */
  ok: boolean;
}

/** The workspace's daily budgets, read inside the tenant scope. */
async function readBudgets(orgId: string, workspaceId: string) {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, workspaceId),
          eq(schema.workspaces.orgId, orgId),
        ),
      )
      .limit(1),
  );
  return dailyBudgetUsdOf(row?.settings);
}

/**
 * Where one lane stands against its budget today. Reads the setting and the
 * counter; throws nothing. The caller decides what a miss means.
 */
export async function laneBudgetStanding(args: {
  orgId: string;
  workspaceId: string;
  lane: SpendLane;
  at?: Date;
}): Promise<LaneBudgetStanding> {
  const at = args.at ?? new Date();
  const budgets = await readBudgets(args.orgId, args.workspaceId);
  const budgetUsd = budgets[SPEND_LANE_KEYS[args.lane]];
  if (budgetUsd === null)
    return { lane: args.lane, budgetUsd: null, spentUsd: 0, ok: true };
  const spentMicros = await sumLaneSpendForDay({
    orgId: args.orgId,
    workspaceId: args.workspaceId,
    lane: args.lane,
    at,
  });
  const spentUsd = Number(spentMicros) / 1_000_000;
  return { lane: args.lane, budgetUsd, spentUsd, ok: spentUsd < budgetUsd };
}

/**
 * Refuse a call once the lane's daily budget is spent. Throws
 * {@link WorkspaceBudgetSpentError}; fails open on a read failure.
 */
export async function assertUnderWorkspaceLaneBudget(args: {
  orgId: string;
  workspaceId: string;
  lane: SpendLane;
  at?: Date;
}): Promise<void> {
  let standing: LaneBudgetStanding;
  try {
    standing = await laneBudgetStanding(args);
  } catch (err) {
    logger.error(
      {
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        lane: args.lane,
        alert: "billing_workspace_lane_budget_failed_open",
        err: err instanceof Error ? err.message : String(err),
      },
      "billing: the workspace lane budget could not be read, admitting the call",
    );
    return;
  }
  if (standing.ok || standing.budgetUsd === null) return;
  logger.warn(
    {
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      lane: args.lane,
      budgetUsd: standing.budgetUsd,
      spentUsd: standing.spentUsd,
    },
    "billing: workspace lane budget spent, refusing the call",
  );
  throw new WorkspaceBudgetSpentError(
    args.lane,
    standing.budgetUsd,
    standing.spentUsd,
  );
}
