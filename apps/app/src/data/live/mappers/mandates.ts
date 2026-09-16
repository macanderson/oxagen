// list_mandates output to the mandate view models (ARCHITECTURE.md §3.4).
// Typed from the contract's `_output`; every field the contract may leave
// unrecorded — who asked, who granted, the role they held, a limit with no
// per-period figure — is null in the view model and nothing is invented.
//
// A limit names either an ISO 4217 currency or a unit of a count
// (`mandates/schemas.ts`), told apart by `isCurrencyCode` rather than by the
// shape of the name, so a three-letter unit such as GAU stays a count. Every
// figure of one measure is carried in that measure's form, counts as the
// integer string the ledger recorded. The ratios the meter draws are computed
// here, on integers, so the component does no arithmetic (INV-09).
//
// The answer is stamped `asOf` with the instant it was mapped, because whether
// a mandate is in effect is a question about an instant and a component may
// not ask a clock during render.
import type { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import type { z } from "zod";
import type { MandateList, MeasureValue } from "@/data/contracts/mandates";
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

export function toMandateList(
  out: Out,
  limit: number,
  asOf: Date = new Date(),
): z.input<typeof MandateList> {
  return {
    asOf: asOf.toISOString(),
    truncatedAt: out.items.length >= limit ? limit : null,
    mandates: out.items.map((item) => ({
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
    })),
  };
}
