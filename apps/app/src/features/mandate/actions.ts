"use server";
// The two governed writes on one mandate (#2957; ADR-059): change its limits
// and revoke it. Both go through the kernel seam for the workspace viewer the
// URL names, and both are `noBillingGate` — a mandate is authority, not spend.
//
// **Neither action decides who may write.** `update_mandate_limits` and
// `revoke_mandate` each resolve the mandate's consequence tags, read the
// workspace's `consequence_roles` overrides, and call `assertConsequenceRole`
// before they touch a row (`packages/handlers/src/mandate.limits.update.ts`,
// `mandate.revoke.ts`), which reaches `assertOrgRole` in `@oxagen/iam`. That is
// where the gate belongs, and it is the only place it can be trusted: IAM
// fast-paths a non-enterprise org to an unconditional allow for a human
// principal (`packages/iam/src/check-iam.ts`), so a kernel that "ran the IAM
// check" has not necessarily checked a role. INV-29 is the rule; these actions
// are its clients, not a second implementation of it.
//
// A refusal therefore comes back as `denied` with the handler's reason in
// `code` and nothing changed, and `action-failure.ts` turns each reason into a
// sentence. The page still hides neither control: hiding a button is not a gate,
// and a reader who cannot change a mandate is better told why by the write than
// left guessing which of their roles is missing.
//
// **Limits are written verbatim, never scaled.** This is the same rule
// `requestMandate` (features/agents/actions.ts) carries, and for the same
// reason: whether a measure is money or a count is a property of the tool
// version's declaration, and no contract the app may call answers a tool
// version's `measures`. Storing a typed 50 as 50000000 micros would be a
// millionfold over-grant whenever the declaration turns out to be a count, and
// a mandate whose bound is wider than the operator typed is the one failure a
// mandate surface must not have. So the figure typed is the figure stored, a
// currency-denominated unit is refused here, and a money limit is changed over
// the API or MCP by a caller that holds the declaration. The app reads one back
// as money either way.
import type { z } from "zod";
import {
  mandateLimitsUpdate,
  mandateLimitsUpdateFields,
} from "@oxagen/oxagen/contracts/mandate.limits.update";
import { mandateRevoke } from "@oxagen/oxagen/contracts/mandate.revoke";
import { MEASURE_VALUE } from "@/data/contracts/mandates";
import { isCurrencyCode } from "@/data/contracts/money";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { viewerTimeZone } from "@/server/viewer-zone";
import { endOfZonedDay } from "@/shared/calendar-day";

/**
 * What the dialog had in the editable fields when it opened, as it rendered
 * them.
 *
 * It travels with the submission, as a hidden input beside each editable field,
 * so this action can tell a value the operator changed from one they never
 * touched. Every editable field is prefilled from the mandate the page read, and
 * a prefill sent back unchanged is not a change: the handler reads every field a
 * request carries as an explicit edit, so a submission that asserted its
 * prefills could restore a bound another operator had lowered since the dialog
 * opened, through the very path the row lock made atomic (ADR-102, amended
 * 2026-09-19).
 */
export type LimitsBaseline = {
  measure: string;
  unit: string;
  period: "daily" | "weekly" | "monthly";
  perCall: string;
  perPeriod: string;
  callsPerDay: string;
};

/** The fields the change-limits dialog collects. */
export type LimitsDraft = {
  mandateId: string;
  /** The measure the tool version declares the limit under. */
  measure: string;
  /** What the measure counts, in its own name. Never an ISO 4217 code. */
  unit: string;
  /** The limits as typed, in whole units of `unit`. Nothing here is scaled. */
  perCall: string;
  perPeriod: string;
  period: "daily" | "weekly" | "monthly";
  /** An optional cap on the built-in `calls` measure, per day. */
  callsPerDay: string;
  /** The last day the mandate may be drawn on (`YYYY-MM-DD`); blank keeps the window. */
  validTo: string;
  /** What the dialog prefilled into the fields above, so an untouched one can be told from an edit. */
  baseline: LimitsBaseline;
};

/**
 * The changes this action sends, taken from the contract rather than restated:
 * measure → the fields to change on that measure's bound, where an absent field
 * means the stored one is kept. The handler merges it under the row lock
 * (ADR-102).
 */
// Derived from the field schema rather than from the contract's `input`. That
// input is `.object().strict().refine(...)`, so it is a ZodEffects and indexing
// `z.input<...>` on it answers `unknown`, which typechecks here and loses every
// bound the moment it is written to. The field is exported for the same reason
// the xmcp tool needs it.
type MandateLimitChanges = NonNullable<
  z.input<typeof mandateLimitsUpdateFields.limitChanges>
>;

/** The day a date input gives; `endOfZonedDay` turns it into an instant. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The one built-in measure (`CALLS_MEASURE`): every call draws exactly one of
 * it, whatever a limit says. A limit on anything else filed under that name
 * stops measuring what it names, and `assertToolsDeclareMeasures` exempts
 * `calls` from the declared-measure check, so nothing downstream would catch
 * it. The measure field refuses the name and the calls-per-day field is the
 * only writer of that limit.
 */
const RESERVED_MEASURE = "calls";

function refuse(field: keyof LimitsDraft): ActionResult<never> {
  return { ok: false, reason: "invalid", code: "invalid_input", field };
}

/**
 * Changes an active mandate's limits, and its validity end when one is given.
 *
 * **It sends what the operator changed, and nothing else — it does not read the
 * mandate.** `update_mandate_limits` also takes `limitChanges`, a set of changes
 * keyed by measure, and merges them over the stored record inside the
 * transaction that locks the row (ADR-102). So this action makes exactly one
 * kernel call. The merge it used to do here read the record over the network
 * first, and that read was a snapshot nobody held a lock on: two operators
 * editing different bounds on one mandate each posted a complete record back,
 * and the later write restored the bound the earlier one had lowered. Restoring
 * a bound widens the agent's authority with nobody asking, which is the failure
 * class ARCHITECTURE.md §9 records on this lane.
 *
 * **The patch is sparse, and that is what makes the merge atomic in practice.**
 * The dialog prefills the measure, the unit, the window and both figures from the
 * mandate the page read, so a submission that changed only the validity date
 * still holds every one of those values. The handler cannot tell an echo from an
 * edit: it merges whatever the change carries over the locked row. So the
 * baseline travels with the draft and a field is carried only when it differs
 * from it, and a validity-only submission carries no limit change at all. Without
 * that, a calls-only or date-only submission would restore the count bound
 * another operator had just lowered, through the atomic path rather than around
 * it.
 *
 * The consequence a person has to know about is unchanged: a blank field leaves
 * that measure's bound as it is rather than removing it. Removing a limit
 * entirely means sending a whole `limits` record without it, which is
 * `update_mandate_limits` over the API or MCP; a form whose blank fields could
 * delete bounds would delete them by accident far more often than on purpose.
 * The dialog's copy says so. A field the operator cleared is absent from the
 * patch for the same reason an untouched one is: neither says to change the
 * stored bound.
 *
 * Lowering a per-period limit under authority the period has already drawn is
 * accepted on purpose: the ledger is a record and an update may not rewrite it.
 * The mandate is then over its limit, which `MandateAuthority.overLimit` carries
 * and the bar says in words.
 */
export async function changeMandateLimits(
  org: string,
  ws: string,
  draft: LimitsDraft,
): Promise<ActionResult<{ mandateId: string; status: string }>> {
  const measure = draft.measure.trim();
  const unit = draft.unit.trim();
  const perCall = draft.perCall.trim();
  const perPeriod = draft.perPeriod.trim();
  const callsPerDay = draft.callsPerDay.trim();
  const validTo = draft.validTo.trim();

  /**
   * The same fields as the dialog prefilled them, trimmed the same way so a
   * comparison is between two values read alike. Each one arrived from the same
   * `measureDefaults` result that seeded the visible field beside it, in the same
   * render of the same form, so a baseline cannot describe a default the operator
   * never saw.
   */
  const was = {
    measure: draft.baseline.measure.trim(),
    unit: draft.baseline.unit.trim(),
    perCall: draft.baseline.perCall.trim(),
    perPeriod: draft.baseline.perPeriod.trim(),
    callsPerDay: draft.baseline.callsPerDay.trim(),
    period: draft.baseline.period,
  };

  // A mandate over the built-in measure alone is a legitimate shape, and the
  // only one available to a tool that carries a consequence and declares no
  // numeric measure: `mandateLimitsSchema` needs one limit and `calls` is one.
  const wantsMeasure =
    measure !== "" || unit !== "" || perCall !== "" || perPeriod !== "";

  if (callsPerDay !== "" && !MEASURE_VALUE.test(callsPerDay))
    return refuse("callsPerDay");

  let perCallValue: string | null = null;
  let perPeriodValue: string | null = null;
  if (wantsMeasure) {
    if (measure === "" || measure === RESERVED_MEASURE)
      return refuse("measure");
    // A unit that is an ISO 4217 code reads back as money (`isCurrencyCode`)
    // while the figure beside it is whole units, which is the one shape this
    // form cannot write correctly. Refused in either casing, because an
    // operator who means money means it whichever way they type it.
    if (unit === "" || isCurrencyCode(unit.toUpperCase()))
      return refuse("unit");
    if (perCall === "" && perPeriod === "") return refuse("perPeriod");
    if (perCall !== "") {
      if (!MEASURE_VALUE.test(perCall)) return refuse("perCall");
      perCallValue = perCall;
    }
    if (perPeriod !== "") {
      if (!MEASURE_VALUE.test(perPeriod)) return refuse("perPeriod");
      perPeriodValue = perPeriod;
    }
  }

  if (validTo !== "" && !DATE.test(validTo)) return refuse("validTo");

  /**
   * Whether this submission is editing the bound the dialog prefilled or has
   * named a different measure. A different name is a different bound, one the
   * record may not hold at all, so nothing typed against it can be a prefill left
   * over from another measure and every field of it is carried.
   */
  const isSameMeasure = measure === was.measure;

  /** A value that differs from the one this field opened with. */
  const edited = (value: string, prefilled: string) =>
    !isSameMeasure || value !== prefilled;

  /**
   * What this submission changed on the named measure, and nothing more.
   *
   * A field is carried only when the operator's value differs from the prefill,
   * because the handler reads every field a change carries as an explicit edit.
   * A prefill sent back is an assertion that the stored bound should be what this
   * dialog read some minutes ago, and on a mandate another operator has narrowed
   * since, that assertion restores a bound nobody entered. The row lock makes the
   * merge atomic; it cannot tell an edit from an echo.
   *
   * An absent field is what the merge reads as "keep what is stored", which is
   * what an untouched field means and what a cleared one means too: clearing is
   * not deletion, and a bound is removed by a whole-record `limits` write over
   * the API or MCP, as the dialog's copy says.
   */
  const measureChange = wantsMeasure
    ? {
        ...(perCallValue !== null && edited(perCallValue, was.perCall)
          ? { perCall: perCallValue }
          : {}),
        ...(perPeriodValue !== null && edited(perPeriodValue, was.perPeriod)
          ? { perPeriod: perPeriodValue }
          : {}),
        ...(edited(draft.period, was.period) ? { period: draft.period } : {}),
        ...(edited(unit, was.unit) ? { currencyOrUnit: unit } : {}),
      }
    : {};

  const limitChanges: MandateLimitChanges = {
    ...(Object.keys(measureChange).length === 0
      ? {}
      : { [measure]: measureChange }),
    // The calls cap's measure name is fixed, so its own figure is the whole
    // comparison. No period, deliberately: the form shows the cap as a bare
    // number and exposes no period control for it, so this submission says
    // nothing about the window, and the handler's merge keeps the stored one.
    // Writing `daily` here turned a stored cap of ten calls a week into ten a
    // day on any submission, including one that only changed a validity date.
    ...(callsPerDay === "" || callsPerDay === was.callsPerDay
      ? {}
      : {
          [RESERVED_MEASURE]: {
            perPeriod: callsPerDay,
            currencyOrUnit: RESERVED_MEASURE,
          },
        }),
  };

  // Nothing was changed. `update_mandate_limits` refuses a request that names no
  // change at all, and a submission holding only its prefills has named none, so
  // it is refused here, with a field a person can act on, rather than reaching
  // the kernel as a schema failure that names none.
  if (Object.keys(limitChanges).length === 0 && validTo === "")
    return refuse("perPeriod");

  const ctx = await requireViewer(org, ws);

  // The day the operator picked is a day in the zone this app draws dates in,
  // not a day in UTC. This used to append `T23:59:59.999Z` to the picked day,
  // which is the right instant only for an operator already on UTC: at UTC+9 it
  // granted nine hours nobody asked for.
  //
  // Read only when there is a day to place in a zone, so a limit-only change
  // still makes exactly one kernel call. A zone that cannot be established
  // refuses rather than falling back, because a guessed zone moves an authority
  // boundary by up to a day and says nothing about having guessed
  // (`server/viewer-zone.ts`).
  let validToInstant: string | null = null;
  if (validTo !== "") {
    const zone = await viewerTimeZone(ctx, "mandates");
    if (!zone.ok) return zone;
    validToInstant = endOfZonedDay(validTo, zone.timeZone);
    if (validToInstant === null) return refuse("validTo");
  }

  // One write, carrying only what changed. The handler merges it over the stored
  // record under the lock it already takes, at both depths: every measure this
  // submission did not name keeps its bound, and each named measure keeps every
  // field this submission did not carry, its other sublimit and its window
  // included. That is why the window of a calls cap the form cannot express
  // survives a submission that only changes the figure.
  const result = await kernelWrite(ctx, mandateLimitsUpdate, {
    mandateId: draft.mandateId,
    // Omitted rather than sent empty: the contract refuses a change that names
    // no measure, and a change to the window alone is a legal change.
    ...(Object.keys(limitChanges).length === 0 ? {} : { limitChanges }),
    // The last day a mandate may be drawn on runs through the end of that day,
    // in the operator's own calendar rather than UTC's.
    ...(validToInstant === null ? {} : { validTo: validToInstant }),
  });
  return result.ok
    ? {
        ok: true,
        value: { mandateId: result.value.id, status: result.value.status },
      }
    : result;
}

/**
 * Revokes the mandate with a reason.
 *
 * The handler releases, in the same transaction, every reservation held by a
 * call that has not dispatched and expires those approval rows, so revoking
 * ends in-flight calls that have not dispatched. Nothing already settled is
 * touched: a settlement records an effect that happened, and the ledger keeps
 * every movement it has recorded.
 */
export async function revokeMandate(
  org: string,
  ws: string,
  input: { mandateId: string; reason: string },
): Promise<ActionResult<{ mandateId: string; status: string }>> {
  const reason = input.reason.trim();
  if (reason === "")
    return {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "reason",
    };
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, mandateRevoke, {
    mandateId: input.mandateId,
    reason,
  });
  return result.ok
    ? {
        ok: true,
        value: { mandateId: result.value.id, status: result.value.status },
      }
    : result;
}
