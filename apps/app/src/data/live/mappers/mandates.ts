// list_mandates output to the mandate view models (ARCHITECTURE.md §3.4).
// Typed from the contract's `_output`; every field the contract may leave
// unrecorded — who asked, who granted, the role they held, a limit with no
// per-period figure — is null in the view model and nothing is invented.
//
// A limit names either a currency or a unit (`mandates/schemas.ts`), so the
// mapper reads the shape of that name once per measure and carries every
// figure of that measure in the same form. The ratios the meter draws are
// computed here, on integers, so the component does no arithmetic (INV-09).
import type { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import type { z } from "zod";
import type { MandateList, MeasureValue } from "@/data/contracts/mandates";
import { moneyFromMicros, ratioOfIntegers } from "@/data/contracts/money";
import type { ContractOutput } from "@/server/kernel";

type Out = ContractOutput<typeof mandateList>;
type MandateOut = Out["items"][number];
type AuthorityOut = MandateOut["authority"][number];

/** An ISO 4217 code: what a limit names when its measure is an amount. */
const CURRENCY = /^[A-Z]{3}$/;

function measureValue(
  value: string,
  currencyOrUnit: string,
): z.input<typeof MeasureValue> {
  return CURRENCY.test(currencyOrUnit)
    ? { kind: "money", money: moneyFromMicros(value, currencyOrUnit) }
    : { kind: "count", count: Number(value), unit: currencyOrUnit };
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
  };
}

export function toMandateList(out: Out): z.input<typeof MandateList> {
  return {
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
