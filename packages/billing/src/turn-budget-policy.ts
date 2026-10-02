import { z } from "zod";
import { TURN_BUDGET_MODE_VALUES } from "./turn-budget";

/**
 * turn-budget-policy.ts: the wire shape of the per-turn `budget` field a chat
 * request may carry.
 *
 * No customer-configured budget applies to Oxagen's in-app assistant
 * (ADR-235 item 10). The REST chat route still accepts the field and ignores
 * it, so an older client that sends one is not refused (ADR-277). The field is
 * still validated, so a malformed budget answers 400 as it always has.
 */

/**
 * A chat request's `budget` field. `limitUsd` must be a positive number
 * whenever `enabled` is true.
 */
export const requestTurnBudgetSchema = z
  .object({
    enabled: z.boolean(),
    limitUsd: z.number().positive().nullable(),
    mode: z.enum(TURN_BUDGET_MODE_VALUES),
    graceOveragePct: z.number().min(0).max(10),
  })
  .refine((v) => !v.enabled || (v.limitUsd !== null && v.limitUsd > 0), {
    message:
      "budget.limitUsd must be a positive number when budget.enabled is true",
    path: ["limitUsd"],
  });

export type RequestTurnBudget = z.output<typeof requestTurnBudgetSchema>;
