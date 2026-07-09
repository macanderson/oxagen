import type { CapabilityHandler } from "@oxagen/oxagen";
import { budgetPolicyWrite } from "@oxagen/oxagen/contracts/budget.policy.write";
// user_preferences is user-global (no org_id, no RLS policy) — withSystemDb is correct.
import { schema, withSystemDb } from "@oxagen/database";
import type { NewUserPreferences } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

type BudgetMode = "grace" | "prompt" | "enforce";

function normalizeMode(raw: string | null | undefined): BudgetMode {
  return raw === "grace" || raw === "enforce" ? raw : "prompt";
}

export const budgetPolicyWriteHandler: CapabilityHandler<
  typeof budgetPolicyWrite
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn({}, "budget.policy.write: rejected — no authenticated user");
    throw new Error("budget.policy.write requires an authenticated user");
  }

  const userId = ctx.userId;

  // First-insert values. Only the budget columns are set here; every other
  // user_preferences column has a schema default, so a budget-first write
  // (no prior preferences row) still produces a valid row.
  const insertValues: NewUserPreferences = {
    userId,
    createdByUserId: userId,
    updatedByUserId: userId,
    perTurnBudgetEnabled: input.enabled ?? false,
    perTurnBudgetMode: input.mode ?? "prompt",
    perTurnBudgetGracePct: input.graceOveragePct ?? 0.25,
    // omit = column default NULL; null = explicit NULL; number = the limit.
    ...("limitUsd" in input ? { perTurnBudgetUsd: input.limitUsd } : {}),
  };

  // Partial update — only fields explicitly provided change; anything omitted
  // keeps its existing value.
  const updateSet: Partial<NewUserPreferences> & { updatedByUserId: string } = {
    updatedByUserId: userId,
  };
  if (input.enabled !== undefined)
    updateSet.perTurnBudgetEnabled = input.enabled;
  if (input.mode !== undefined) updateSet.perTurnBudgetMode = input.mode;
  if (input.graceOveragePct !== undefined)
    updateSet.perTurnBudgetGracePct = input.graceOveragePct;
  if ("limitUsd" in input) updateSet.perTurnBudgetUsd = input.limitUsd;

  await withSystemDb((tx) =>
    tx.insert(schema.userPreferences).values(insertValues).onConflictDoUpdate({
      target: schema.userPreferences.userId,
      set: updateSet,
    }),
  );

  const row = await withSystemDb((tx) =>
    tx.query.userPreferences.findFirst({
      where: eq(schema.userPreferences.userId, userId),
      columns: {
        perTurnBudgetEnabled: true,
        perTurnBudgetUsd: true,
        perTurnBudgetMode: true,
        perTurnBudgetGracePct: true,
      },
    }),
  );

  if (!row) {
    throw new Error("budget.policy.write: upserted row not found on re-read");
  }

  logger.info(
    { userId, surface: ctx.surface, enabled: row.perTurnBudgetEnabled },
    "budget.policy.write: per-turn budget updated",
  );

  return {
    enabled: row.perTurnBudgetEnabled,
    limitUsd: row.perTurnBudgetUsd ?? null,
    mode: normalizeMode(row.perTurnBudgetMode),
    graceOveragePct: row.perTurnBudgetGracePct,
  };
};
