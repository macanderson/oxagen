// The Spend page's two forms (#2962): a spend ceiling, read into the
// set_spend_budget input, and the month a statement covers. Issues carry keys
// under `spend.budgetDialog.errors.*`; the contract still parses the input on
// every invoke, and a field it refuses maps back through `budgetFieldErrors`.
import { z } from "zod";
import { microsFromDecimal } from "@/data/contracts/money";

export type BudgetFormValues = {
  scope: "org" | "workspace";
  period: "monthly" | "rolling";
  windowDays: string;
  /** The limit in US dollars, as typed. */
  limit: string;
  enabled: boolean;
};

type BudgetFormErrorKey = "limitInvalid" | "windowDaysInvalid";
export type BudgetFieldErrors = Partial<
  Record<"limit" | "windowDays", BudgetFormErrorKey>
>;

const WINDOW_DAYS = /^[1-9]\d{0,3}$/;

export const BudgetForm = z
  .object({
    scope: z.enum(["org", "workspace"]),
    period: z.enum(["monthly", "rolling"]),
    windowDays: z.string(),
    limit: z.string(),
    enabled: z.boolean(),
  })
  .transform((form, ctx) => {
    const micros = microsFromDecimal(form.limit);
    if (micros === null || micros === "0") {
      ctx.addIssue({
        code: "custom",
        path: ["limit"],
        message: "limitInvalid",
      });
      return z.NEVER;
    }
    const days = form.windowDays.trim();
    if (form.period === "rolling" && !WINDOW_DAYS.test(days)) {
      ctx.addIssue({
        code: "custom",
        path: ["windowDays"],
        message: "windowDaysInvalid",
      });
      return z.NEVER;
    }
    return {
      scope: form.scope,
      enabled: form.enabled,
      period: form.period,
      ...(form.period === "rolling" ? { windowDays: Number(days) } : {}),
      // The store records ceilings in micro-USD (set_spend_budget).
      limit: { micros, currency: "USD" },
    };
  });

/** The field a refusal names, by the head of its path: the form's or the contract's. */
export function budgetFieldErrors(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): BudgetFieldErrors {
  const errors: BudgetFieldErrors = {};
  for (const issue of issues) {
    const head = String(issue.path[0] ?? "");
    if (head === "limit") errors.limit = "limitInvalid";
    if (head === "windowDays") errors.windowDays = "windowDaysInvalid";
  }
  return errors;
}

/** A calendar month as export_statement takes it. */
export function isStatementMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** A finding's public id as the finding contracts take it (`fnd_…`). */
export function isFindingId(value: string): boolean {
  return /^fnd_[0-9a-z]+$/.test(value);
}
