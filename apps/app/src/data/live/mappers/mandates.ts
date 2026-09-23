// list_mandates output to the mandate view models (ARCHITECTURE.md §3.4).
// Typed from the contract's `_output`; every field the contract may leave
// unrecorded — who asked, who granted, the role they held, a limit with no
// per-period figure — is null in the view model and nothing is invented.
//
// A limit names either an ISO 4217 currency or a unit of a count
// (`mandates/schemas.ts`). Whether a given measure is money or a count is
// carried on the wire as `kind` (ADR-108), stamped by the handler from the
// declaration it validated at write time, the same fact `readMeasure`
// (packages/rules/src/mandates/measures.ts) switches on to enforce the gate,
// `switch (declaration.type)`, never guessed. **This mapper reads that stored
// kind instead of guessing**: `measureValue` takes it and switches on it, the
// same way the gate does. A ledger row whose limit was later deleted
// (`update_mandate_limits`' whole-record replacement) has no stored kind to
// read, since the ledger is append-only and outlives the limit that once
// bounded it; that one case falls back to `legacyMeasureKindGuess`, the same
// guess a pre-ADR-108 row without a stored kind takes. Before ADR-108 this
// branch called
// `isCurrencyCode(currencyOrUnit)`, which read a declared **count**
// denominated in a currency code (`{ type: "count", unit: "USD" }`) as money:
// a whole-unit count of 50 printed as $0.00 while the gate enforced 50
// counted units. `isCurrencyCode` still has one legitimate job, refusing a
// currency-code unit on the request form in `actions.ts`, and stays there;
// it decides nothing here any more. Every figure of one measure is carried
// in that measure's form, counts as the integer string the ledger recorded.
// The ratios the meter draws are computed here, on integers, so the
// component does no arithmetic (INV-09).
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
  moneyFromMicros,
  ratioOfIntegers,
  sumExceeds,
} from "@/data/contracts/money";
import type { ContractOutput } from "@/server/kernel";
import { legacyMeasureKindGuess } from "@oxagen/rules";

type Out = ContractOutput<typeof mandateList>;
type MandateOut = Out["items"][number];
type AuthorityOut = MandateOut["authority"][number];
type DetailOut = ContractOutput<typeof mandateGet>;
// Not `@oxagen/oxagen/mandates/schemas`' `MeasureKind`: §2 keeps that module
// out of the app (`data/contracts/mandates.ts`), so this is derived from the
// contract output already in scope, the same as every other type on this file.
type MeasureKind = AuthorityOut["kind"];

function measureValue(
  value: string,
  currencyOrUnit: string,
  kind: MeasureKind,
): z.input<typeof MeasureValue> {
  return kind === "money"
    ? { kind: "money", money: moneyFromMicros(value, currencyOrUnit) }
    : { kind: "count", count: value, unit: currencyOrUnit };
}

function toAuthority(
  authority: AuthorityOut,
): z.input<typeof MandateList>["mandates"][number]["authority"][number] {
  const of = (value: string) =>
    measureValue(value, authority.currencyOrUnit, authority.kind);
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

/**
 * The approval rule's thresholds, each in its measure's own form where the
 * mandate's limits establish what that form is.
 *
 * `humanAbove` is a measure-keyed record of integer strings and names neither a
 * currency nor a unit, so the only evidence for the form is the limit on the
 * same measure — which is exactly where `authority` got its own. A threshold on a
 * measure the mandate does not limit therefore has no form, and `value` is null
 * rather than assumed: the rule is still in force, and the page prints the
 * recorded digits beside the measure's name. Guessing money or a count there
 * would be the mistake ADR-108 removed from `measureValue` above, one layer
 * further from the evidence.
 */
function toApproval(
  item: MandateOut,
): z.input<typeof MandateList>["mandates"][number]["approval"] {
  const formOf = (
    measure: string,
  ): { unit: string; kind: MeasureKind } | null => {
    const limit = item.authority.find((entry) => entry.measure === measure);
    return limit === undefined
      ? null
      : { unit: limit.currencyOrUnit, kind: limit.kind };
  };
  return {
    humanAbove: Object.entries(item.approval.humanAbove).map(
      ([measure, recorded]) => {
        const form = formOf(measure);
        return {
          measure,
          value:
            form === null ? null : measureValue(recorded, form.unit, form.kind),
          recorded,
        };
      },
    ),
    alwaysHumanFor: [...item.approval.alwaysHumanFor],
    approvers: [...item.approval.approvers],
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
    targets: Object.entries(item.targets).map(([measure, rule]) => ({
      measure,
      allow: [...rule.allow],
      deny: [...rule.deny],
    })),
    approval: toApproval(item),
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

/** What a call's movements on one measure have reached: a release or a settlement closes it. */
function stateOf(
  kinds: ReadonlySet<"reserve" | "settle" | "release">,
): "reserve" | "settle" | "release" {
  if (kinds.has("settle")) return "settle";
  if (kinds.has("release")) return "release";
  return "reserve";
}

/**
 * `get_mandate` to the mandate page's record. The limits and the authority go
 * through the same row mapper the ledger tables read, so the figures on the
 * detail page and the figures in the two tables are one mapping.
 *
 * **The ledger is folded into draws.** A call's reservation and the settlement
 * or release that closes it are two movements of one draw, written with the
 * same value (`closeReservations`, packages/rules/src/mandates.ts). The page
 * lists draws, one per call and measure, in the state the call reached, so a
 * settled call is one row reading settled rather than a settled row beside a
 * reserved one that still reads reserved. The movements arrive newest first,
 * so the first movement seen for a draw is its newest and orders it.
 *
 * Each draw keeps the measure's own form (micros under a currency, whole units
 * under a unit name) through the same `measureValue` the limits use, so a draw
 * and the limit it drew against are printed by the same rule. `toolCallId`
 * groups the movements and goes no further: it is a raw database uuid, as is
 * the row's `id`, and INV-11 admits neither into a view model (`MandateDraw`
 * carries the reasoning).
 */
export function toMandateDetail(
  out: DetailOut,
  ledgerLimit: number,
  asOf: Date = new Date(),
): z.input<typeof MandateDetail> {
  type Row = DetailOut["ledger"][number];
  const groups = new Map<string, { rows: Row[] }>();
  for (const row of out.ledger) {
    const key = `${row.toolCallId}\u0000${row.measure}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { rows: [row] });
    else group.rows.push(row);
  }
  return {
    asOf: asOf.toISOString(),
    // What the read can establish: the bound it asked for, when the answer
    // filled it. Not "truncated" — a ledger of exactly the bound looks the same
    // as one of the bound plus a thousand, and `get_mandate` answers no total, no
    // has-more flag and no cursor to tell them apart (`MandateDetail.readBound`).
    readBound: out.ledger.length >= ledgerLimit ? ledgerLimit : null,
    mandate: toMandateRow(out.mandate),
    draws: [...groups.values()].map(({ rows }) => {
      const state = stateOf(new Set(rows.map((r) => r.kind)));
      // The movement that decided the state carries the figure and the
      // effect; every movement of a draw records the same value.
      const decisive = rows.find((r) => r.kind === state) ?? rows[0];
      const newest = rows[0];
      if (decisive === undefined || newest === undefined)
        throw new Error("a draw with no movement");
      // The row's own `measureKind` (ADR-108) is the fact: stamped once
      // when the row was written and never re-derived, it survives a later
      // whole-record `limits` replacement that removes the measure, where
      // `authority` has nothing left to look up. A row written before that
      // column existed falls back to `authority` (the measure's current
      // limit, if it still has one), then to the same guess a pre-ADR-108
      // row without a stored kind takes (`legacyMeasureKindGuess`, from the
      // row's own `unitOrCurrency`), a guess only for a row this old AND
      // whose measure is gone, never for one ADR-108 already resolved.
      const authorityKind =
        decisive.measureKind ??
        out.mandate.authority.find((a) => a.measure === decisive.measure)
          ?.kind ??
        legacyMeasureKindGuess(decisive.unitOrCurrency);
      const effect = rows.find((r) => r.kind === "settle")?.externalEffectId;
      return {
        state,
        measure: decisive.measure,
        value: measureValue(
          decisive.value,
          decisive.unitOrCurrency,
          authorityKind,
        ),
        // Empty means "nothing recorded" here, not "a value of no length".
        // `packages/rules/src/mandates.ts` stores whatever the tool's
        // configured effect-id path returned, an empty string included, and
        // `get_mandate` answers it unchanged. The view model requires a
        // non-empty string or null, so passing one through failed
        // `MandateDetail.safeParse` and the whole page answered
        // `record_unmappable` over one settlement, a ledger withheld
        // because one row named its transaction with nothing.
        externalEffectRef:
          effect === undefined || effect === null || effect.trim() === ""
            ? null
            : effect,
        periodKey: decisive.periodKey,
        at: newest.at,
      };
    }),
  };
}
