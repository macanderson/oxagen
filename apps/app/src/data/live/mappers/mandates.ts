// list_mandates output to the mandate view models (ARCHITECTURE.md §3.4).
// Typed from the contract's `_output`; every field the contract may leave
// unrecorded — who asked, who granted, the role they held, a limit with no
// per-period figure — is null in the view model and nothing is invented.
//
// A limit names either an ISO 4217 currency or a unit of a count
// (`mandates/schemas.ts`), told apart by `isCurrencyCode` rather than by the
// shape of the name, so a three-letter unit such as GAU stays a count. **This
// is the one place in the system that guesses whether a measure is money**, and
// it is a stand-in, not a rule: the gate does not guess — `readMeasure`
// (packages/rules/src/mandates/measures.ts) switches on `declaration.type`,
// which is the fact — and `assertToolsDeclareMeasures` now holds that same
// declaration while it validates the write. A tool may legitimately declare
// `{ type: "count", unit: "USD" }`, and the handler accepts a limit matching
// that unit while this branch reads its whole-unit count as micros: 50 counted
// units rendered as $0.00. The fix is to carry the declared `type` from the
// write, where it is known, onto the limit and through `mandateAuthoritySchema`
// — not a further test on the unit string, because no test on a unit string can
// answer a question about a type. It needs the stored limit shape to change
// (#3024's jsonb) and so is not this PR's; ARCHITECTURE.md §9 carries the
// analysis and the reader list. Every
// figure of one measure is carried in that measure's form, counts as the
// integer string the ledger recorded. The ratios the meter draws are computed
// here, on integers, so the component does no arithmetic (INV-09).
//
// The answer is stamped `asOf` with the instant it was mapped, because whether
// a mandate is in effect is a question about an instant and a component may
// not ask a clock during render.
import type { mandateGet } from "@oxagen/oxagen/contracts/mandate.get";
import type { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import type { z } from "zod";
import type {
  MandateDetail,
  MandateList,
  MeasureValue,
} from "@/data/contracts/mandates";
import {
  isCurrencyCode,
  moneyFromMicros,
  ratioOfIntegers,
  sumExceeds,
} from "@/data/contracts/money";
import type { ContractOutput } from "@/server/kernel";

type Out = ContractOutput<typeof mandateList>;
type MandateOut = Out["items"][number];
type AuthorityOut = MandateOut["authority"][number];
type DetailOut = ContractOutput<typeof mandateGet>;

function measureValue(
  value: string,
  currencyOrUnit: string,
): z.input<typeof MeasureValue> {
  return isCurrencyCode(currencyOrUnit)
    ? { kind: "money", money: moneyFromMicros(value, currencyOrUnit) }
    : { kind: "count", count: value, unit: currencyOrUnit };
}

function toAuthority(
  authority: AuthorityOut,
): z.input<typeof MandateList>["mandates"][number]["authority"][number] {
  const of = (value: string) => measureValue(value, authority.currencyOrUnit);
  const { perPeriod } = authority;
  return {
    measure: authority.measure,
    period: authority.period,
    periodKey: authority.periodKey,
    perCall: authority.perCall === null ? null : of(authority.perCall),
    perPeriod: perPeriod === null ? null : of(perPeriod),
    settled: of(authority.settled),
    reserved: of(authority.reserved),
    remaining: authority.remaining === null ? null : of(authority.remaining),
    settledRatio:
      perPeriod === null ? null : ratioOfIntegers(authority.settled, perPeriod),
    reservedRatio:
      perPeriod === null
        ? null
        : ratioOfIntegers(authority.reserved, perPeriod),
    // Taken here, on the recorded integers, because the two ratios above are
    // clamped and quantized and cannot be asked this afterwards.
    overLimit:
      perPeriod === null
        ? false
        : sumExceeds(authority.settled, authority.reserved, perPeriod),
  };
}

/** One mandate row, shared by `list_mandates` and `get_mandate`: the same view model. */
function toMandateRow(
  item: MandateOut,
): z.input<typeof MandateList>["mandates"][number] {
  return {
    id: item.id,
    agentId: item.agentId,
    agentSlug: item.agentSlug,
    requestedBy: item.requestedBy,
    grantedBy: item.grantedBy,
    roleAtGrant: item.roleAtGrant,
    consequenceTags: item.consequenceTags,
    tools: item.tools,
    purpose: item.purpose,
    validFrom: item.validFrom,
    validTo: item.validTo,
    status: item.status,
    authority: item.authority.map(toAuthority),
  };
}

export function toMandateList(
  out: Out,
  limit: number,
  asOf: Date = new Date(),
): z.input<typeof MandateList> {
  return {
    asOf: asOf.toISOString(),
    truncatedAt: out.items.length >= limit ? limit : null,
    mandates: out.items.map(toMandateRow),
  };
}

/**
 * `get_mandate` to the mandate page's record. The limits and the authority go
 * through the same row mapper the ledger tables read, so the figures on the
 * detail page and the figures in the two tables are one mapping.
 *
 * The ledger rows keep the measure's own form — micros under a currency, whole
 * units under a unit name — through the same `measureValue` the limits use, so
 * a movement and the limit it drew against are printed by the same rule. The
 * row's `id` and `toolCallId` are dropped rather than carried: both are raw
 * database uuids and INV-11 admits none into a view model (`MandateLedgerRow`
 * carries the reasoning).
 */
export function toMandateDetail(
  out: DetailOut,
  ledgerLimit: number,
  asOf: Date = new Date(),
): z.input<typeof MandateDetail> {
  return {
    asOf: asOf.toISOString(),
    truncatedAt: out.ledger.length >= ledgerLimit ? ledgerLimit : null,
    mandate: toMandateRow(out.mandate),
    ledger: out.ledger.map((row) => ({
      kind: row.kind,
      measure: row.measure,
      value: measureValue(row.value, row.unitOrCurrency),
      externalEffectId: row.externalEffectId,
      periodKey: row.periodKey,
      at: row.at,
    })),
  };
}
