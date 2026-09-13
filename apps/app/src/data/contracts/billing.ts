// The Billing page: plan, run allowance, meters and invoices (spec §12.1,
// App. A.8 `billing.subscriptions`).
import { z } from "zod";
import { Count, Day, Money } from "./common";

export const BillingPlan = z.object({
  plan: z.enum(["free", "team", "enterprise"]),
  status: z.enum(["active", "past_due", "cancelled"]),
  nextInvoiceOn: Day,
  /** A time-boxed discount the organization holds, if any. */
  discount: z
    .object({
      description: z.string(),
      percentOff: z.number().min(0).max(100),
      until: Day,
    })
    .nullable(),
});
export type BillingPlan = z.infer<typeof BillingPlan>;

/** G13: the per-run allowance for the current period. */
export const RunAllowance = z.object({
  includedRuns: Count,
  runsUsed: Count,
  billableRuns: Count,
  overagePerRun: Money,
  usage: Money,
  discount: Money,
  total: Money,
  retention: z.object({
    includedMonths: Count,
    retainedGb: z.number().nonnegative(),
    charge: Money,
  }),
});
export type RunAllowance = z.infer<typeof RunAllowance>;

export const MeterKey = z.enum([
  "sealed_runs",
  "governed_actions",
  "retained_evidence_gb",
  "halted_before_model_call",
  "assistant_runs",
  "witness_runs",
]);
export type MeterKey = z.infer<typeof MeterKey>;

export const Meter = z.object({
  key: MeterKey,
  value: z.number().nonnegative(),
  /** Only the billable unit is priced; the rest are reported. */
  priced: z.boolean(),
});
export type Meter = z.infer<typeof Meter>;

export const Invoice = z.object({
  number: z.string(),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  runs: Count,
  amount: Money,
  status: z.enum(["paid", "open", "void"]),
  issuedOn: Day,
});
export type Invoice = z.infer<typeof Invoice>;
