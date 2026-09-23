/**
 * `set_org_billing_terms`: the platform operator's half of the billing-terms
 * pair (apps/app/ARCHITECTURE.md §3.9 item 12, WL-30). It approves one
 * organisation for invoice billing and sets the uninvoiced-overage ceiling at
 * which an interim invoice is cut. The customer sees both read-only on the
 * billing page and can change neither.
 *
 * This is the first `platformOnly: true` contract. Three declarations carry
 * that:
 *
 *   - `platformOnly: true` — the kernel refuses the invocation before the IAM
 *     check unless the context carries a binding minted by
 *     `createPlatformOperatorContext` (INV-31). This is the boundary.
 *   - `surfaces: []` — no API route, no MCP tool, no CLI command, no app
 *     binding. `layers` lists only what exists: the schema, the unit test and
 *     this doc.
 *   - `defaultEffect: "deny"` with `defaultRoles: {}` — no role in any
 *     organisation grants it. On its own this decides nothing below
 *     enterprise, which is why the kernel check exists.
 *
 * `scoped: false`: the call carries no tenant. The handler upserts on
 * `withSystemDb`, keyed on the input's `orgId`, because a platform operator
 * acts on an organisation rather than inside one.
 *
 * It also sets the org's monthly cap on platform-paid assistant tokens
 * (`assistantSpendCapCents`, ADR-053 §3), the one other commercial term a
 * platform operator owns. The column defaults to $20 a month, and the rev1 app
 * has no control for it, so an enterprise that prepays assistant credits needs
 * an operator to raise it. A call may set the billing mode, the cap, or both:
 * the mode's two fields travel together, and at least one group is present.
 *
 * The one caller is `tools/scripts/billing-terms.ts`
 * (`pnpm billing:terms --org <slug> [--invoice-billing on|off
 * --invoice-gau-max <n>] [--assistant-cap-usd <n|none>]`), run against the
 * production `DATABASE_URL` the way `pnpm billing:stripe-sync` is.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * Uninvoiced overage, in GAUs, at which an interim invoice is cut. Read only
 * when `approvedForInvoiceBilling` is true; stored and inert otherwise. The
 * column's CHECK is `> 0`; the upper bound is a typo guard on a figure an
 * operator types by hand.
 */
const invoiceGauMaxSchema = z.number().int().min(1).max(100_000_000);

/**
 * The monthly cap on platform-paid assistant tokens, in credit cents; null is
 * no cap. Zero refuses every platform-paid assistant turn.
 */
const assistantSpendCapSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable();

export const billingOrgTermsSet = registerCapability({
  name: "set_org_billing_terms",
  domain: "billing",
  description:
    "Platform-operator only: approve an organization for invoice billing or return it to prepaid, set the uninvoiced-overage ceiling at which an interim invoice is cut, and set the monthly cap on platform-paid assistant tokens.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "unit", "docs"],
  scoped: false,
  platformOnly: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: {}, workspace: {} },
  input: z
    .object({
      orgId: z.string().uuid(),
      approvedForInvoiceBilling: z.boolean().optional(),
      invoiceGauMax: invoiceGauMaxSchema.optional(),
      assistantSpendCapCents: assistantSpendCapSchema.optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      const mode = [v.approvedForInvoiceBilling, v.invoiceGauMax];
      const given = mode.filter((x) => x !== undefined).length;
      if (given === 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "approvedForInvoiceBilling and invoiceGauMax are set together",
          path: [
            v.approvedForInvoiceBilling === undefined
              ? "approvedForInvoiceBilling"
              : "invoiceGauMax",
          ],
        });
      }
      if (given === 0 && v.assistantSpendCapCents === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Nothing to set: give the billing mode, the assistant spend cap, or both",
          path: [],
        });
      }
    }),
  /** The stored row after the call, read back from the writes. */
  output: z
    .object({
      orgId: z.string().uuid(),
      approvedForInvoiceBilling: z.boolean(),
      invoiceGauMax: invoiceGauMaxSchema,
      assistantSpendCapCents: assistantSpendCapSchema,
    })
    .strict(),
});

export type BillingOrgTermsSetInput = z.output<typeof billingOrgTermsSet.input>;
export type BillingOrgTermsSetOutput = z.output<
  typeof billingOrgTermsSet.output
>;
