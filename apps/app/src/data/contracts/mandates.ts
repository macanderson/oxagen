// The mandate view models (ARCHITECTURE.md §1.2, #2957; MC spec §6.9): the
// mandates a workspace has granted, each with its grant and the remaining
// authority the ledger records by measure. `list_mandates` is the one read
// behind all three surfaces that show a mandate — the ledger the accountable
// office reads on Tools, the mandates one agent holds on Agents, and the bar
// on an approval card — so there is one view model for a mandate row.
//
// A measure is money or a count, which is why a value is a discriminated
// union rather than a bare number (INV-09). Which one is not read from the
// unit's spelling: `mappers/mandates.ts` switches on the `kind` the contract
// carries (ADR-108), never on whether `currencyOrUnit` looks like an ISO 4217
// code: a tool may legitimately declare a count denominated in a currency
// code, and a guess from the spelling gets that case wrong.
import { z } from "zod";
import { type OrgRole, PublicId } from "./common";
import { isCurrencyCode, Money } from "./money";

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

/**
 * One counterparty rule: which targets a measure of this mandate may and may
 * not be drawn against. The stored shape is a measure-keyed record; the view
 * model is a list because a record's key order is not a thing a page may rely
 * on, and every consumer renders it as rows.
 */
// Not exported, and the inferred type not aliased: nothing outside this file
// names either, only through `MandateRow["targets"][number]`. knip flags an
// export nothing imports.
const MandateTargetRule = z.object({
  measure: z.string().min(1),
  allow: z.array(z.string().min(1)),
  deny: z.array(z.string().min(1)),
});

/**
 * One threshold in the mandate's own approval rule: above this figure of this
 * measure, a person answers the call.
 *
 * It carries the figure twice, on purpose. `value` is the figure in the
 * measure's own form, which is knowable only when the mandate holds a limit on
 * that measure — the limit is what names the currency or the unit, and
 * `humanAbove` names neither. `recorded` is the integer string as stored, and it
 * is what the page prints when `value` is null: a threshold whose units cannot
 * be established is shown as the digits the record holds and labelled with its
 * measure, rather than being guessed into dollars or dropped from a rule that is
 * in force either way.
 */
// Not exported, and the inferred type not aliased, same reason as
// `MandateTargetRule` above.
const MandateApprovalThreshold = z.object({
  measure: z.string().min(1),
  value: MeasureValue.nullable(),
  recorded: z.string().regex(/^\d+$/),
});

/**
 * The mandate's own approval rule (`mandateApprovalSchema`): when a person has
 * to answer a call this mandate would otherwise allow.
 *
 * An empty `approvers` list is a rule and not an absence: it leaves the answer
 * to the org roles accountable for the consequence. A surface that printed it as
 * an empty list would say the opposite of what it means, so the rule is rendered
 * as sentences and never as the shape.
 */
// Not exported, and the inferred type not aliased, same reason as
// `MandateTargetRule` above.
const MandateApproval = z.object({
  humanAbove: z.array(MandateApprovalThreshold),
  alwaysHumanFor: z.array(z.string().min(1)),
  approvers: z.array(z.string().min(1)),
});

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
  /** Which targets each measure may be drawn against; empty when the grant named no rule. */
  targets: z.array(MandateTargetRule),
  /** When a person answers a call this mandate would otherwise allow. */
  approval: MandateApproval,
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
 * What one movement in the ledger did: authority was held at decision time,
 * then either spent on a recorded effect or handed back. The three read as a
 * dot and a word on the page, never as a colour alone.
 */
export const MandateMovement = z.enum(["reserve", "settle", "release"]);
export type MandateMovement = z.infer<typeof MandateMovement>;

/**
 * One row of `tools.mandate_ledger` as the mandate page shows it.
 *
 * **It carries no identifier, and that is the constraint rather than an
 * omission.** The ledger row's `id` and `tool_call_id` are raw uuids
 * (`packages/database/src/schema/tools.ts`), `get_mandate` passes them through
 * as recorded, and INV-11 keeps a raw database id out of every view model —
 * which is the same rule as CLAUDE.md's: a uuid is not a name a person can
 * read. So the view model drops both, the table keys its rows by position, and
 * the *Call* column names the measure the movement drew. The tool version the
 * call named is not recoverable from any read the app may make: the schema's
 * own comment says `control.tool_calls` is not in the tree, so nothing resolves
 * `tool_call_id` to a tool. The page says so under the table rather than
 * printing a uuid or leaving the column blank.
 */
export const MandateLedgerRow = z.object({
  kind: MandateMovement,
  /** The measure the movement drew, as the mandate's limits name it. */
  measure: z.string().min(1),
  value: MeasureValue,
  /**
   * The transaction, migration, message or deployment the settlement recorded,
   * as the external system named it: a payment intent, a commit, a message id.
   * Null on a reservation, which has not caused an effect yet, and on a release,
   * which never will.
   *
   * **It is a `…Ref`, not an id field, because it is not one of ours.** INV-11
   * makes every `id` and `…Id` on a view model a prefixed `PublicId`, and this
   * value is a third party's string that Oxagen mints nothing of and cannot
   * validate — `tools.ts` carries the same kind under the same suffix. Naming it
   * `…Id` would have forced a choice between a false `PublicId` and an exemption
   * that any later raw uuid could hide behind.
   */
  externalEffectRef: z.string().min(1).nullable(),
  /** The accounting window the movement was counted in, as the ledger keys it. */
  periodKey: z.string().min(1),
  at: Instant,
});
export type MandateLedgerRow = z.infer<typeof MandateLedgerRow>;

/**
 * One mandate and its ledger: the page's whole record (`get_mandate`).
 *
 * **`readBound` is what the read can establish, and its name says so.** It is
 * the `ledgerLimit` the read asked for, set when the answer filled it and null
 * when the answer came back short. It is deliberately **not** called
 * `truncatedAt`, and the copy above the table does not say older movements exist:
 * `get_mandate` takes a bound and no cursor, so a ledger of exactly the bound is
 * indistinguishable from one of the bound plus a thousand, and a page that
 * announced truncation on a ledger of exactly 500 would be making a false
 * statement about an audit record. What the page can honestly say is what it read
 * and that it cannot tell whether there is more, which is what the string says.
 *
 * Telling full from truncated needs the contract to answer it — a total, a
 * has-more flag, or a cursor on `get_mandate`. Until one exists this is the
 * strongest honest claim, and the figures in the tiles are unaffected either way:
 * remaining authority is the ledger's own accounting (INV-10), never a sum of
 * these rows.
 */
export const MandateDetail = z.object({
  mandate: MandateRow,
  /** Newest movement first, as `get_mandate` orders them. */
  ledger: z.array(MandateLedgerRow),
  asOf: Instant,
  readBound: z.number().int().positive().nullable(),
});
export type MandateDetail = z.infer<typeof MandateDetail>;

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
 *
 * **The window is half-open, `[validFrom, validTo)`, because enforcement's
 * is.** `findCoveringMandate` selects on `lte(m.validFrom, args.at)` and
 * `gt(m.validTo, args.at)` (`packages/rules/src/mandates.ts:471-472`), so at
 * exactly `validTo` the gate has already stopped honouring the mandate. This
 * read `now <= validTo` and for that one instant told an accountable office
 * the agent held live authority while every call carrying its consequence was
 * being denied — the page wrong about the only thing it is for. A boundary is
 * the cheapest place for a mirror to disagree and the hardest place to notice,
 * so both ends are quoted here and pinned at the instant itself.
 *
 * What this deliberately does not mirror: the gate also requires the mandate
 * to name every consequence the tool declares and to match the tool pattern.
 * Those are questions about a call, and no call is named on this page, so
 * `isEffective` answers the weaker "could this mandate authorize anything now"
 * — which is the claim the surfaces actually make.
 */
export function isEffective(mandate: MandateRow, at: Date): boolean {
  if (mandate.status !== "active") return false;
  const now = at.getTime();
  return (
    Date.parse(mandate.validFrom) <= now && now < Date.parse(mandate.validTo)
  );
}

/**
 * Whether `update_mandate_limits` would accept a change to this mandate, which
 * is a different question from whether it authorizes anything now.
 *
 * Mirrors the handler's own two conditions (`packages/handlers/src/
 * mandate.limits.update.ts`): the locked row must be `active`, and its
 * exclusive `validTo` must not have elapsed. It deliberately says nothing about
 * `validFrom`, because the handler does not either: a granted mandate whose
 * window has not opened is exactly the one an operator most needs to correct
 * before its authority starts.
 *
 * `isEffective` is the wrong gate for an edit control and was used as one. It
 * answers "could this authorize a call now", so it excludes a scheduled
 * mandate, and the app's only limit-change control vanished for the rows that
 * are still safe to change. Being stricter than the kernel is not the safe
 * direction here: it removes the last surface that can fix a scheduled bound,
 * leaving an operator to revoke and re-grant to change a number.
 *
 * A draft is excluded by the status test, which is correct: the handler takes
 * an active mandate alone, and a draft is declined rather than edited.
 */
export function isChangeable(mandate: MandateRow, at: Date): boolean {
  if (mandate.status !== "active") return false;
  return at.getTime() < Date.parse(mandate.validTo);
}

/**
 * Whether this mandate is granted and has simply not started. `isEffective`
 * excludes it correctly — a window that has not opened authorizes nothing —
 * but the exclusion loses why, and the row still reads `active` wherever the
 * status is printed. Without this a surface has only two sentences for a row
 * that authorizes nothing, "a request awaiting a decision" and "history", and
 * an upcoming grant is neither: saying either of them contradicts the status
 * on the same screen.
 *
 * Deliberately not the negation of `isEffective`: a draft, a revoked row and
 * an expired one are all not-effective and none of them is upcoming. The
 * question is about a grant that exists and has a start date still ahead.
 *
 * The comparison is the exact negation of enforcement's lower bound,
 * `lte(m.validFrom, args.at)` (`packages/rules/src/mandates.ts:471`) — strict,
 * so a mandate is upcoming up to but not including the instant it starts, and
 * effective from that instant on. The two predicates meet with no gap and no
 * overlap at `validFrom`, which is pinned on both sides.
 */
export function isUpcoming(mandate: MandateRow, at: Date): boolean {
  return (
    mandate.status === "active" && at.getTime() < Date.parse(mandate.validFrom)
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

// ── The authority questions this app answers locally ──────────────────────
//
// §2 keeps `packages/rules` and `packages/handlers` out of the app, so every
// question the surfaces ask about what an agent may do is answered against a
// copy of a rule enforcement owns. A copy that disagrees with the gate makes
// the page wrong about the only thing it is for, and a boundary is the
// cheapest place for one to disagree and the hardest place to notice — which
// is how `isEffective` shipped reporting live authority for the one instant at
// `validTo` while the gate was already denying. Each is listed with what it
// mirrors, whether it provably matches, and which way it errs when it cannot.
//
// - `isEffective` / `isUpcoming` — mirror `findCoveringMandate`'s status and
//   window clauses (`packages/rules/src/mandates.ts:467-472`). Provably match:
//   the window is half-open at both ends and every boundary instant is pinned,
//   including the handover between the two predicates at `validFrom`. They do
//   not mirror the gate's consequence-coverage and tool-pattern clauses, on
//   purpose — those are questions about a call, and no call is named here.
// - `EVERY_TOOL` (`@/ui/mandate-scope`) — decides that a mandate covers every
//   tool. Provably sound: `toolMatches` reaches `matchGlob`, which returns
//   true for the literal pattern `*` before any conversion
//   (`packages/mcp-config/src/permissions.ts:65`). Not complete — `**` would
//   also match everything and renders as its literal text instead. That under-
//   claims, leaving the reader the pattern to judge, which is the direction
//   that cannot mislead.
// - `ACCOUNTABLE_READERS` (below) — a copy of `ACCOUNTABLE_ORG_ROLES` in
//   `packages/handlers/src/_mandate.ts` that **cannot be made to match** from
//   here, because the handler never reports whether it narrowed. It is written
//   to err toward hedging, and the durable answer is a visibility flag on
//   `list_mandates`' own output (ARCHITECTURE.md §9), not a better copy.
// - The retirement gate (`features/agents/mandates.tsx`) — the page declines to
//   offer a request that `request_mandate` would accept, because retirement
//   suspends the principal and the handler does not resolve that status. The
//   app is deliberately stricter than the kernel; closing it on the other
//   surfaces is filed as #3124.
// - The bounds block below — copies of the request schemas, each naming its
//   rule and each pinned by an assertion that quotes the rule as a literal
//   rather than importing the copy under test.

// ── The contract bounds this app mirrors ──────────────────────────────────
//
// §2 keeps `@oxagen/oxagen/mandates/schemas` out of the app, so every bound the
// request form applies is a copy, and a copy is where a bound drifts from the
// rule it came from in silence. Each one below names the rule it mirrors and is
// pinned by `mandates.test.ts`. A bound that is deliberately narrower than its
// rule says so and why; a bound nobody can trace to a rule does not belong here.
//
// The failure this prevents is specific: an app bound tighter than the contract
// refuses or truncates a request the platform would have accepted, and a
// truncated consequence set is still syntactically valid — so it is requested,
// granted exactly as submitted, and covers no tool.

/** `consequenceTagSchema`: snake_case, 2 to 64 characters. */
export const CONSEQUENCE_TAG = /^[a-z][a-z0-9_]{1,63}$/;

/** `consequenceTagSchema`'s length ceiling, for the field that collects them. */
const CONSEQUENCE_TAG_MAX = 64;

/** `mandateSchema.consequenceTags`: `.min(1).max(16)`. */
const MAX_CONSEQUENCE_TAGS = 16;

/**
 * `MEASURE_VALUE`: an integer string of up to thirty digits, no leading zero.
 * Every limit figure the form writes is checked against this — the measure's
 * and the built-in `calls` one alike, since `calls` is a measure limit like any
 * other and a tighter rule for it refuses a cap the ledger can hold.
 */
export const MEASURE_VALUE = /^(0|[1-9][0-9]{0,29})$/;

/** `measureNameSchema`: snake_case, up to 64 characters. */
export const MEASURE_NAME_MAX = 64;

/**
 * `measureNameSchema`: `/^[a-z][a-z0-9_]{0,63}$/`. Every measure a form names
 * (a limit, a counterparty rule, an approval threshold) is a record key the
 * contract checks against this, so a form checks it first and names the field.
 */
export const MEASURE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** `mandateLimitSchema.currencyOrUnit`: `.min(1).max(32)`. */
export const UNIT_MAX = 32;

/** `mandateSchema.purpose`: `.min(1).max(2000)`. */
export const PURPOSE_MAX = 2000;

/**
 * The longest legal value of the free consequence field: every tag at its
 * ceiling, comma-and-space separated. Derived rather than chosen, because a
 * chosen number is the bound that drifts.
 */
export const CONSEQUENCE_OTHER_MAX =
  MAX_CONSEQUENCE_TAGS * CONSEQUENCE_TAG_MAX + (MAX_CONSEQUENCE_TAGS - 1) * 2;

/**
 * `mandateApproverSchema`: `role:<org role>` or `user:<usr_…>`, either casing.
 * The role names are the four `iam-provision.ts` gives every org.
 */
export const MANDATE_APPROVER =
  /^(role:(Owner|Admin|Compliance|Billing)|user:usr_[0-9a-z]+)$/i;

/** The four org roles `MANDATE_APPROVER` admits as `role:<name>`. */
export const APPROVER_ROLES = [
  "Owner",
  "Admin",
  "Compliance",
  "Billing",
] as const;

/** The starter set of consequence tags (MC spec §6.9 part 1); a workspace adds its own. */
export const STARTER_CONSEQUENCE_TAGS = [
  "moves_money",
  "destroys_data",
  "alters_production",
  "communicates_externally",
  "changes_access",
  "changes_entitlement",
] as const;

/** `mandateTargetSchema`: each allowed or denied target is 1 to 256 characters. */
export const TARGET_MAX = 256;

// ── The limits a mandate form writes ──────────────────────────────────────
//
// Two forms write a mandate body: the request on the agent page and the grant
// on the Tools ledger. Both collect one measure limit and an optional cap on
// the built-in `calls` measure, and both must refuse the same shapes for the
// same reasons, so the rule lives here once rather than in two actions that
// drift. `requestMandate` (features/agents/actions.ts) carries the full
// reasoning; the short form is below.

/** The one built-in measure (`CALLS_MEASURE`): every call draws exactly one. */
const RESERVED_MEASURE = "calls";

/** One measure's bound, as `mandateLimitSchema` takes it. */
type MandateLimit = {
  perCall?: string;
  perPeriod?: string;
  period: "daily" | "weekly" | "monthly";
  currencyOrUnit: string;
};

/** The limit fields a mandate form collects, as typed. */
export type MandateLimitFields = {
  measure: string;
  unit: string;
  perCall: string;
  perPeriod: string;
  period: "daily" | "weekly" | "monthly";
  callsPerDay: string;
};

/**
 * The limits record a form's fields describe, or the field that is wrong.
 *
 * - **Verbatim.** A figure is stored as typed, never scaled to micros: whether
 *   a measure is money is a property of the tool version's declaration, which
 *   no contract the app may call answers. Scaling a count would store a
 *   millionfold wider bound than the person entered.
 * - **No currency unit.** A unit that is an ISO 4217 code reads back as money
 *   while the figure is whole units, so it is refused in either casing.
 * - **Not `calls`.** Every call draws one of those whatever a limit says, and
 *   the grant handler exempts it from the declared-measure check, so a limit
 *   filed under that name stops measuring what it names. The calls-per-day
 *   field is the only writer of that limit.
 * - **Snake_case, as `measureNameSchema` has it.** A name the contract refuses
 *   is named on its field here rather than as a schema failure naming none.
 * - **The measure is optional.** A cap on calls alone is a legal mandate and the
 *   only one a tool that declares no numeric measure can carry. The four
 *   measure fields stand or fall together.
 *
 * The checks run in a fixed order so a form names the same field for the same
 * mistake wherever it is made.
 */
export function mandateLimitsOf(
  fields: MandateLimitFields,
):
  | { ok: true; limits: Record<string, MandateLimit> }
  | { ok: false; field: keyof MandateLimitFields } {
  const measure = fields.measure.trim();
  const unit = fields.unit.trim();
  const perCall = fields.perCall.trim();
  const perPeriod = fields.perPeriod.trim();
  const callsPerDay = fields.callsPerDay.trim();
  if (callsPerDay !== "" && !MEASURE_VALUE.test(callsPerDay))
    return { ok: false, field: "callsPerDay" };

  const wantsMeasure =
    measure !== "" || unit !== "" || perCall !== "" || perPeriod !== "";
  if (!wantsMeasure && callsPerDay === "")
    return { ok: false, field: "perPeriod" };

  const limits: Record<string, MandateLimit> = {};
  if (wantsMeasure) {
    if (measure === RESERVED_MEASURE || !MEASURE_NAME.test(measure))
      return { ok: false, field: "measure" };
    if (
      unit === "" ||
      unit.length > UNIT_MAX ||
      isCurrencyCode(unit.toUpperCase())
    )
      return { ok: false, field: "unit" };
    if (perCall === "" && perPeriod === "")
      return { ok: false, field: "perPeriod" };
    if (perCall !== "" && !MEASURE_VALUE.test(perCall))
      return { ok: false, field: "perCall" };
    if (perPeriod !== "" && !MEASURE_VALUE.test(perPeriod))
      return { ok: false, field: "perPeriod" };
    limits[measure] = {
      ...(perCall === "" ? {} : { perCall }),
      ...(perPeriod === "" ? {} : { perPeriod }),
      period: fields.period,
      currencyOrUnit: unit,
    };
  }
  if (callsPerDay !== "")
    limits[RESERVED_MEASURE] = {
      perPeriod: callsPerDay,
      period: "daily",
      currencyOrUnit: RESERVED_MEASURE,
    };
  return { ok: true, limits };
}

/**
 * The consequence set a form names, deduplicated, or null when it is empty,
 * too long, or holds a tag `consequenceTagSchema` refuses. A mandate covers a
 * tool only when it names every tag the tool declares, so this is a set and not
 * a choice.
 */
export function consequenceTagsOf(raw: string): string[] | null {
  const tags = [...new Set(listOf(raw))];
  return tags.length === 0 ||
    tags.length > MAX_CONSEQUENCE_TAGS ||
    !tags.every((tag) => CONSEQUENCE_TAG.test(tag))
    ? null
    : tags;
}

/** A comma-separated field as its trimmed, non-blank entries, in order. */
export function listOf(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}
