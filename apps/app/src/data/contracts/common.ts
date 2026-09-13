// Shared view-model enums and scalars, in the spec's vocabulary (spec App. A),
// never the mockup's strings. The fixture adapter maps mockup values onto these
// once; every page, port and adapter reads these names.
import { z } from "zod";

/** A public id: a lowercase kind prefix, an underscore, then a base-62 body (`run_01K5RS…`). */
export const PublicId = z.string().regex(/^[a-z]+_[A-Za-z0-9]+$/);
export type PublicId = z.infer<typeof PublicId>;

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

export const EnforcementTier = z.enum(["gateway", "harness", "observe"]);
export type EnforcementTier = z.infer<typeof EnforcementTier>;

export const ReplayGrade = z.enum(["inspect", "view", "fork", "retry"]);
export type ReplayGrade = z.infer<typeof ReplayGrade>;

export const Verdict = z.enum([
  "flipped",
  "failing",
  "unmoved",
  "unsatisfied",
  "tampered",
  "unverified",
  "waived",
  "none",
]);
export type Verdict = z.infer<typeof Verdict>;

export const Risk = z.enum(["low", "medium", "high", "critical"]);
export type Risk = z.infer<typeof Risk>;

export const SideEffect = z.enum(["read", "write", "irreversible"]);
export type SideEffect = z.infer<typeof SideEffect>;

export const EgressClass = z.enum(["local", "org_tenant", "third_party"]);
export type EgressClass = z.infer<typeof EgressClass>;

/**
 * Steering record kinds: the six real kinds Stella's `RecordKind` and the mockup
 * carry (plan §6 Q5). The spec's "twelve kinds" is a spec defect to correct.
 */
export const RecordKind = z.enum([
  "rule",
  "constraint",
  "procedure",
  "fact",
  "memory",
  "preference",
]);
export type RecordKind = z.infer<typeof RecordKind>;
