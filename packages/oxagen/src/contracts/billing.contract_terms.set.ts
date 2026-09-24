/**
 * `set_contract_terms`: the platform operator's write of an organization's
 * negotiated governed-action terms (ADR-055 §2, `billing.contract_terms`).
 *
 * The terms are what an enterprise signed: the agreement reference, the
 * currency, the rate per governed action unit, the block size a purchase is
 * sold in, and the units included each month. The reader
 * (`packages/billing/src/contract-terms.ts`) prefers the negotiated row in
 * force over the published tier, so from `effectiveFrom` on these are the
 * figures the gate, the recorder, the settlement invoices and a prepaid
 * order's default rate use. The org's current bucket keeps the included units
 * it was created with; the next month's bucket takes the new figure.
 *
 * Platform-operator only, the way `set_org_billing_terms` is:
 *   - `platformOnly: true`: the kernel refuses the invocation unless the
 *     context carries a binding minted by `createPlatformOperatorContext`
 *     (INV-31). This is the boundary.
 *   - `surfaces: []`: no API route, MCP tool, CLI command or app binding.
 *   - `defaultEffect: "deny"`, `defaultRoles: {}`: no role grants it.
 *
 * `scoped: false`: the call carries no tenant. The one caller is
 * `tools/scripts/billing-contract-terms.ts` (`pnpm billing:contract-terms`).
 *
 * The whole-cents rule (`rate × block size` a multiple of 10,000 micros) is
 * checked by the handler before any write, with a message that names the
 * figures; the table's CHECK is the backstop.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/** Micro-units of the currency per unit, as a decimal string: a bigint on the wire. */
const microsSchema = z
  .string()
  .regex(/^\d{1,15}$/, "a whole number of micro-units");

const INT4_MAX = 2_147_483_647;

export const billingContractTermsSet = registerCapability({
  name: "set_contract_terms",
  domain: "billing",
  description:
    "Platform-operator only: record an organization's negotiated governed-action terms (agreement reference, currency, rate per unit, block size, included units per month) from an effective date, closing the agreement they replace.",
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
      /** The signed agreement, printed on every invoice line these terms price. */
      agreementRef: z.string().trim().min(1).max(140),
      /** ISO 4217, lower case. */
      currency: z.string().regex(/^[a-z]{3}$/),
      ratePerGauMicros: microsSchema,
      blockSizeGau: z.number().int().min(1).max(INT4_MAX),
      includedGauPerMonth: z.number().int().min(0).max(INT4_MAX),
      /** RFC 3339; defaults to the moment of the call. */
      effectiveFrom: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
  output: z
    .object({
      orgId: z.string().uuid(),
      agreementRef: z.string(),
      currency: z.string().length(3),
      ratePerGauMicros: microsSchema,
      blockSizeGau: z.number().int(),
      includedGauPerMonth: z.number().int(),
      /** RFC 3339. */
      effectiveFrom: z.string().datetime(),
      /** False when the open agreement already carried these terms and nothing was written. */
      changed: z.boolean(),
      /** The agreement this call closed, or null when none was open or nothing changed. */
      previous: z
        .object({
          agreementRef: z.string(),
          effectiveFrom: z.string().datetime(),
          effectiveTo: z.string().datetime(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
});

export type BillingContractTermsSetInput = z.output<
  typeof billingContractTermsSet.input
>;
export type BillingContractTermsSetOutput = z.output<
  typeof billingContractTermsSet.output
>;
