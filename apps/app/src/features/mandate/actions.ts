"use server";
// The two governed writes on one mandate (#2957; ADR-059): change its limits
// and revoke it. Both go through the kernel seam for the workspace viewer the
// URL names, and both are `noBillingGate`: a mandate is authority, not spend.
//
// **Neither action decides who may write.** `update_mandate_limits` and
// `revoke_mandate` each resolve the mandate's consequence tags and call
// `assertConsequenceRole` before they touch a row
// (`packages/handlers/src/mandate.limits.update.ts`, `mandate.revoke.ts`),
// which reaches `assertOrgRole` in `@oxagen/iam`. That is where the gate
// belongs: IAM fast-paths a non-enterprise org to an allow for a human
// principal (`packages/iam/src/check-iam.ts`). A refusal comes back as `denied`
// with the handler's reason in `code` and nothing changed, and
// `action-failure.ts` turns each reason into a sentence.
//
// **A figure is scaled by the kind the record carries, never by a guess.** The
// dialog edits the measure the tiles speak for, in that measure's own unit. This
// action reads the mandate first and takes the measure's kind from the stored
// limit (ADR-108: stamped by the handler from the tool's declaration at write
// time). A money measure's figure is typed as a decimal and stored as micros; a
// count's is stored digit for digit. The kind is never taken from the browser,
// because a count a client claimed was money would be stored a millionfold
// wider than typed.
//
// **Only what the operator changed is sent.** Every field arrives with the
// value it opened with, and a field travels only when the two differ. The
// handler merges `limitChanges` under the row lock (ADR-102) and reads every
// field a change carries as an edit, so an echoed prefill could restore a bound
// another operator lowered since the dialog opened. The read above is used for
// the kind and the stored approval rule, never merged back as limits.
import { mandateGet } from "@oxagen/oxagen/contracts/mandate.get";
import { mandateLimitsUpdate } from "@oxagen/oxagen/contracts/mandate.limits.update";
import { mandateRevoke } from "@oxagen/oxagen/contracts/mandate.revoke";
import { MEASURE_VALUE } from "@/data/contracts/mandates";
import { microsFromDecimal } from "@/data/contracts/money";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer, viewerTimeZone } from "@/server/viewer";
import { endOfZonedDay, isCalendarDay } from "@/shared/calendar-day";

/** The fields `mandateedit` collects, each as typed. */
export type LimitsDraft = {
  mandateId: string;
  /** The measure the dialog edits: the one the tiles speak for. */
  measure: string;
  perCall: string;
  perPeriod: string;
  /** The mandate's own approval threshold on this measure. */
  approvalAbove: string;
  /**
   * The last day the mandate may be drawn on (`YYYY-MM-DD`). The dialog opens
   * it on the current last day; blank, or the day it opened with, keeps the
   * window.
   */
  validTo: string;
  /** What each field opened with, so an untouched one can be told from an edit. */
  baseline: {
    perCall: string;
    perPeriod: string;
    approvalAbove: string;
    validTo: string;
  };
};

type Kind = "money" | "count";

function refuse(field: keyof LimitsDraft): ActionResult<never> {
  return { ok: false, reason: "invalid", code: "invalid_input", field };
}

/**
 * A typed figure as the integer string the ledger stores, or null when it is
 * not one: micros for money (a decimal, grouping commas allowed), whole units
 * for a count.
 */
function storedOf(typed: string, kind: Kind): string | null {
  const text = typed.trim().replace(/,/g, "");
  if (kind === "money") return microsFromDecimal(text);
  return MEASURE_VALUE.test(text) ? text : null;
}

/**
 * The change one field names, or null when it names none: blank keeps what is
 * stored (removing a bound is a whole-record write over the API), and a value
 * equal to the one it opened with is an echo, not an edit.
 */
function changeOf(
  typed: string,
  opened: string,
  kind: Kind,
): { ok: true; value: string | null } | { ok: false } {
  if (typed.trim() === "") return { ok: true, value: null };
  const value = storedOf(typed, kind);
  if (value === null) return { ok: false };
  const was = opened.trim() === "" ? null : storedOf(opened, kind);
  return { ok: true, value: value === was ? null : value };
}

/**
 * Changes an active mandate's limits on one measure, its approval threshold on
 * that measure, and its validity end, sending only what changed.
 *
 * Lowering a per-period limit under authority the period has already drawn is
 * accepted on purpose: the ledger is a record and an update may not rewrite it.
 * The mandate is then over its limit, which `MandateAuthority.overLimit`
 * carries and the bar says in words.
 */
export async function changeMandateLimits(
  org: string,
  ws: string,
  draft: LimitsDraft,
): Promise<ActionResult<{ mandateId: string; status: string }>> {
  // A prefilled day nobody changed is an echo, not an edit: sending it would
  // move the stored end to the end of that day in this viewer's zone, which
  // widens or narrows a window granted to a different instant.
  const typedValidTo = draft.validTo.trim();
  const validTo =
    typedValidTo === draft.baseline.validTo.trim() ? "" : typedValidTo;
  // `2027-02-31` matches the date shape and `Date.UTC` rolls it into March, so
  // the day must round-trip as the day it claims to be.
  if (validTo !== "" && !isCalendarDay(validTo)) return refuse("validTo");

  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: mandateGet,
    input: { mandateId: draft.mandateId, ledgerLimit: 1 },
    page: "mandates",
  });
  if (!read.ok) return readToActionResult<never>(read);
  const stored = read.value.mandate;
  const authority = stored.authority.find((a) => a.measure === draft.measure);
  if (authority === undefined) return refuse("measure");
  const kind: Kind = authority.kind;

  const perCall = changeOf(draft.perCall, draft.baseline.perCall, kind);
  if (!perCall.ok) return refuse("perCall");
  const perPeriod = changeOf(draft.perPeriod, draft.baseline.perPeriod, kind);
  if (!perPeriod.ok) return refuse("perPeriod");
  const above = changeOf(
    draft.approvalAbove,
    draft.baseline.approvalAbove,
    kind,
  );
  if (!above.ok) return refuse("approvalAbove");

  const measureChange = {
    ...(perCall.value === null ? {} : { perCall: perCall.value }),
    ...(perPeriod.value === null ? {} : { perPeriod: perPeriod.value }),
  };
  const limitChanges =
    Object.keys(measureChange).length === 0
      ? null
      : { [draft.measure]: measureChange };

  // `approval` replaces the stored rule whole, so a change to one threshold
  // carries every other clause as the record holds it now.
  const approval =
    above.value === null
      ? null
      : {
          ...stored.approval,
          humanAbove: {
            ...stored.approval.humanAbove,
            [draft.measure]: above.value,
          },
        };

  if (limitChanges === null && approval === null && validTo === "")
    return refuse("perPeriod");

  // The day the operator picked is a day in the zone this app draws dates in,
  // not a day in UTC. A zone that cannot be established refuses rather than
  // falling back, because a guessed zone moves an authority boundary by up to a
  // day and says nothing about having guessed.
  let validToInstant: string | null = null;
  if (validTo !== "") {
    const zone = await viewerTimeZone(ctx, "mandates");
    if (!zone.ok) return zone;
    validToInstant = endOfZonedDay(validTo, zone.timeZone);
    if (validToInstant === null) return refuse("validTo");
  }

  const result = await kernelWrite(ctx, mandateLimitsUpdate, {
    mandateId: draft.mandateId,
    ...(limitChanges === null ? {} : { limitChanges }),
    ...(approval === null ? {} : { approval }),
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
 * call that has not dispatched and expires those approval rows. Nothing already
 * settled is touched: a settlement records an effect that happened, and the
 * ledger keeps every movement it has recorded.
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
