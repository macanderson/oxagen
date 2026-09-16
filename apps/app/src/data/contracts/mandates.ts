// The mandate view models (ARCHITECTURE.md §1.2, #2957; MC spec §6.9): the
// mandates a workspace has granted, each with its grant and the remaining
// authority the ledger records by measure. `list_mandates` is the one read
// behind all three surfaces that show a mandate — the ledger the accountable
// office reads on Tools, the mandates one agent holds on Agents, and the bar
// on an approval card — so there is one view model for a mandate row.
//
// A measure is money when its limit names an ISO 4217 currency and a count
// when it names a unit (`calls` is the built-in one), which is why a value is
// a discriminated union rather than a bare number (INV-09).
import { z } from "zod";
import { PublicId } from "./common";
import { Money } from "./money";

const Instant = z.iso.datetime({ offset: true });

/** `tools.mandates.status`; a draft is a request nobody has granted yet. */
const MandateStatus = z.enum(["draft", "active", "expired", "revoked"]);

/** The period a per-period limit resets on. */
const MandatePeriod = z.enum(["daily", "weekly", "monthly"]);

/** One measured figure: micros with a currency, or whole units with their name. */
export const MeasureValue = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("money"), money: Money }),
  z.object({
    kind: z.literal("count"),
    count: z.number().int().nonnegative(),
    unit: z.string().min(1),
  }),
]);
export type MeasureValue = z.infer<typeof MeasureValue>;

/**
 * Remaining authority for one measure, as the ledger records it (INV-10):
 * `settled` is the sum of this period's settlements, `reserved` what calls in
 * flight hold, and `remaining` the per-period limit less both. A limit with no
 * per-period figure has no remaining and no ratio.
 */
export const MandateAuthority = z.object({
  /** The measure the tool version declares (`amount`), or the built-in `calls`. */
  measure: z.string().min(1),
  period: MandatePeriod,
  /** The period this authority is counted in, as the ledger keys it. */
  periodKey: z.string().min(1),
  perCall: MeasureValue.nullable(),
  perPeriod: MeasureValue.nullable(),
  settled: MeasureValue,
  reserved: MeasureValue,
  remaining: MeasureValue.nullable(),
  /** settled ÷ perPeriod, and reserved ÷ perPeriod, each 0…1; null without a per-period limit. */
  settledRatio: z.number().min(0).max(1).nullable(),
  reservedRatio: z.number().min(0).max(1).nullable(),
});
export type MandateAuthority = z.infer<typeof MandateAuthority>;

export const MandateRow = z.object({
  id: PublicId,
  agentId: PublicId,
  agentSlug: z.string().min(1),
  /** The person who asked for it, and the person who granted it with the role they held. */
  requestedBy: PublicId.nullable(),
  grantedBy: PublicId.nullable(),
  roleAtGrant: z.string().min(1).nullable(),
  /** The consequences this mandate answers for (`moves_money`, `changes_access`). */
  consequenceTags: z.array(z.string().min(1)),
  /** The tool patterns it covers, over `slug@version`. */
  tools: z.array(z.string().min(1)),
  purpose: z.string().min(1),
  validFrom: Instant,
  validTo: Instant,
  status: MandateStatus,
  authority: z.array(MandateAuthority),
});
export type MandateRow = z.infer<typeof MandateRow>;

export const MandateList = z.object({ mandates: z.array(MandateRow) });
export type MandateList = z.infer<typeof MandateList>;
