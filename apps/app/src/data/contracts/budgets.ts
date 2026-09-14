// Budgets (spec §12.5, App. A.8 `billing.budgets`).
import { z } from "zod";
import { Money } from "./common";

export const BudgetScope = z.enum(["org", "workspace", "operator", "agent"]);
export type BudgetScope = z.infer<typeof BudgetScope>;

export const Budget = z.object({
  scopeKind: BudgetScope,
  /** The organization or workspace slug, person id, or agent key. */
  scopeId: z.string(),
  /** `per_run` is the agent definition's own cap (`budget.per_run_micros`, §6.2). */
  period: z.enum(["daily", "monthly", "rolling", "per_run"]),
  limit: Money,
  spent: Money,
  mode: z.enum(["hard", "soft"]),
});
export type Budget = z.infer<typeof Budget>;
