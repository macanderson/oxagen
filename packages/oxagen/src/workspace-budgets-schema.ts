/**
 * The zod shapes of a workspace's daily model budgets (#5426), kept apart
 * from ./workspace-budgets so the pure helper stays free of zod for the
 * runner and billing.
 */
import { z } from "zod";

/** A lane's daily budget in US dollars: zero or more, with cents, or null for no limit. */
const budgetUsd = z
  .number()
  .finite()
  .min(0)
  .max(100_000)
  .nullable()
  .describe("US dollars per UTC day, or null for no limit");

/** Every lane, as the read answers it. */
export const dailyBudgetUsdSchema = z
  .object({
    runEnrichment: budgetUsd,
    assistant: budgetUsd,
    work: budgetUsd,
  })
  .strict();

/** A patch: a lane left out is unchanged. */
export const dailyBudgetUsdPatchSchema = z
  .object({
    runEnrichment: budgetUsd.optional(),
    assistant: budgetUsd.optional(),
    work: budgetUsd.optional(),
  })
  .strict();

export type DailyBudgetUsdPatch = z.output<typeof dailyBudgetUsdPatchSchema>;
