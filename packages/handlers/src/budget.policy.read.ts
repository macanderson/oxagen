import type { CapabilityHandler } from "@oxagen/oxagen";
import { budgetPolicyRead } from "@oxagen/oxagen/contracts/budget.policy.read";
// user_preferences is user-global (no org_id, no RLS policy) — withSystemDb is correct.
import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

type BudgetMode = "grace" | "prompt" | "enforce";

/** Narrow a free-text stored mode to the enum, defaulting to the gated "prompt". */
function normalizeMode(raw: string | null | undefined): BudgetMode {
  return raw === "grace" || raw === "enforce" ? raw : "prompt";
}

export const budgetPolicyReadHandler: CapabilityHandler<
  typeof budgetPolicyRead
> = async (_input, ctx) => {
  if (!ctx.userId) {
    logger.warn({}, "budget.policy.read: rejected — no authenticated user");
    throw new Error("budget.policy.read requires an authenticated user");
  }

  const row = await withSystemDb((tx) =>
    tx.query.userPreferences.findFirst({
      where: eq(schema.userPreferences.userId, ctx.userId!),
      columns: {
        perTurnBudgetEnabled: true,
        perTurnBudgetUsd: true,
        perTurnBudgetMode: true,
        perTurnBudgetGracePct: true,
      },
    }),
  );

  // No preferences row yet ⇒ the off-by-default policy.
  return {
    enabled: row?.perTurnBudgetEnabled ?? false,
    limitUsd: row?.perTurnBudgetUsd ?? null,
    mode: normalizeMode(row?.perTurnBudgetMode),
    graceOveragePct: row?.perTurnBudgetGracePct ?? 0.25,
  };
};
