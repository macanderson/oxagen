// Shared view-model vocabulary, in the spec's vocabulary (spec App. A), never
// the mockup's strings. Only what a remaining page or primitive reads lives
// here; each page lane adds the vocabulary of the contracts it binds.
import { z } from "zod";

/** ISO 4217 currency code. */
export const Currency = z.string().length(3);
export type Currency = z.infer<typeof Currency>;

/** Where a cost figure came from. A number never reads stronger than its basis. */
export const CostBasis = z.enum([
  "gateway_observed",
  "client_attested",
  "mixed",
  "estimated",
]);
export type CostBasis = z.infer<typeof CostBasis>;

/**
 * Money on the wire: integer micro-units as a decimal string. Never a float and
 * never a display string like "2,450.00", which silently becomes 0 or 2 under
 * parseFloat. Formatting happens only in the `<Money>` component.
 */
export const Money = z.object({
  micros: z.string().regex(/^-?\d+$/),
  currency: Currency,
  basis: CostBasis.optional(),
});
export type Money = z.infer<typeof Money>;

/** `org.org_users.role` (App. A.2). */
export const OrgRole = z.enum([
  "owner",
  "admin",
  "member",
  "billing",
  "compliance",
  "viewer",
]);
export type OrgRole = z.infer<typeof OrgRole>;
