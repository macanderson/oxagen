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
import { type OrgRole, PublicId } from "./common";
import { Money } from "./money";

const Instant = z.iso.datetime({ offset: true });

/** `tools.mandates.status`; a draft is a request nobody has granted yet. */
const MandateStatus = z.enum(["draft", "active", "expired", "revoked"]);

/** The period a per-period limit resets on. */
const MandatePeriod = z.enum(["daily", "weekly", "monthly"]);

/**
 * One measured figure: micros with a currency, or whole units with their name.
 * A count stays the integer string the ledger recorded — the contract allows
 * thirty digits, and a double holds sixteen — so the figure printed and the
 * figure the ratio was taken from are the same number.
 */
export const MeasureValue = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("money"), money: Money }),
  z.object({
    kind: z.literal("count"),
    count: z.string().regex(/^\d+$/),
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
  /**
   * Whether the ledger holds more than the per-period limit now allows, which
   * `update_mandate_limits` does by lowering a limit under authority already
   * drawn. Carried as its own fact because the ratios cannot answer it: they
   * are clamped to 0…1 for drawing, so a settlement of 600 against a limit of
   * 500 arrives as 1 and reads as exactly full. Taken on the recorded integers
   * (`sumExceeds`) before anything is clamped or quantized. False when there
   * is no per-period limit, since there is then nothing to exceed.
   */
  overLimit: z.boolean(),
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

export const MandateList = z.object({
  mandates: z.array(MandateRow),
  /**
   * When the ledger answered. Whether a mandate is in effect is a question
   * about an instant, and the instant a server-rendered page means is the one
   * it read at — not whenever a component happens to run. Carrying it on the
   * answer keeps the clock out of render and makes the judgement reproducible.
   */
  asOf: Instant,
  /**
   * How many rows the read asked for, when the answer filled that many and
   * older mandates may therefore be missing; null when the answer was short of
   * the bound and so is the whole set. `list_mandates` takes no cursor, so a
   * workspace past the bound is told what it is not seeing rather than shown a
   * list that quietly stops.
   */
  truncatedAt: z.number().int().positive().nullable(),
});
export type MandateList = z.infer<typeof MandateList>;

/**
 * The org roles `list_mandates` answers in full. A reader outside this set is
 * narrowed by the handler (`readerFilter`, packages/handlers/src/_mandate.ts)
 * to the agents they created, and the narrowing is silent: the answer is a
 * successful list, and an empty one is indistinguishable from a workspace or
 * an agent that genuinely holds no mandate. So a surface asks this before it
 * says no authority exists, in the same spirit as `truncatedAt` above — say
 * what the view cannot show rather than assert a fact it has not established.
 *
 * The set mirrors `ACCOUNTABLE_ORG_ROLES` there in the app's lowercase
 * spelling; §2 keeps the platform packages out of the app, so it cannot be
 * imported. A role added there and not here hedges for a reader who needs no
 * hedge, which is the direction that cannot mislead. The durable answer is a
 * visibility flag on `list_mandates`' own output (ARCHITECTURE.md §9).
 */
const ACCOUNTABLE_READERS: readonly OrgRole[] = [
  "owner",
  "admin",
  "billing",
  "compliance",
];

/** Whether this reader's answer covers every mandate, or only their own agents'. */
function readsEveryMandate(role: OrgRole): boolean {
  return ACCOUNTABLE_READERS.includes(role);
}

/**
 * Whether this mandate authorizes a call at `at`. Only an `active` row inside
 * its validity window does: a `draft` is a request nobody has granted, and
 * `revoked` and `expired` are history. The window is checked as well as the
 * status because a row may be granted ahead of the day it starts.
 *
 * The surfaces need this because `request_mandate` writes a draft, so a page
 * that counts rows rather than authority stops warning at the exact moment an
 * operator asks for a mandate — the moment they have none and most need
 * telling. The rows themselves are still listed; what they may not do is stand
 * in for authority the agent does not have.
 */
export function isEffective(mandate: MandateRow, at: Date): boolean {
  if (mandate.status !== "active") return false;
  const now = at.getTime();
  return (
    Date.parse(mandate.validFrom) <= now && now <= Date.parse(mandate.validTo)
  );
}

/**
 * Why this answer is not the whole set, or null when it is. Note the question:
 * not "is it empty" but "is it everything". Incompleteness is a property of the
 * answer and not of its length — a reader-narrowed list of fifty rows is just
 * as partial as a narrowed list of none — so every claim a surface makes about
 * such a list is qualified, whether the claim is that nothing is there or that
 * everything is.
 *
 * - `reader_scope` — `list_mandates` narrows a reader without an accountable
 *   org role to the agents they created, and reports the narrowing as an
 *   ordinary successful answer.
 * - `truncated` — the read stopped at the bound it asked for, newest first, so
 *   an older mandate is simply absent. A hundred newer drafts push the one
 *   still in effect off the page, and every row that came back authorizes
 *   nothing.
 *
 * `reader_scope` comes first because it is the stronger statement: the rows are
 * not a prefix of the whole set but a subset of a different shape, so naming
 * the page bound instead would understate what is missing.
 *
 * This is the same failure as the clamped ratio that `overLimit` exists for: a
 * lossy intermediate cannot be asked a question about what it lost. Both are
 * answered from the thing that still holds the evidence — here the reader's
 * role and `truncatedAt`, there the recorded integers.
 */
export type MandateBlindSpot = "reader_scope" | "truncated";

export function blindSpotOf(
  list: MandateList,
  role: OrgRole,
): MandateBlindSpot | null {
  if (!readsEveryMandate(role)) return "reader_scope";
  if (list.truncatedAt !== null) return "truncated";
  return null;
}
