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
import { mandateGet } from "@oxagen/oxagen/contracts/mandate.get";
import { mandateLimitsUpdate } from "@oxagen/oxagen/contracts/mandate.limits.update";
import { mandateRevoke } from "@oxagen/oxagen/contracts/mandate.revoke";
import { MEASURE_VALUE } from "@/data/contracts/mandates";
import { isCurrencyCode } from "@/data/contracts/money";
import type { Read } from "@/data/read";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelRead, kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

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
};

/** The day a date input gives; the action widens it to the end of that day. */
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

/** The stored `limits` record, as `get_mandate` answers it. */
type StoredLimits = ContractOutput<typeof mandateGet>["mandate"]["limits"];

/**
 * A read that did not answer, as the write it was part of reports it.
 *
 * `kernelRead` collapses a denial to the page's permission and loses the
 * handler's reason (`toRead`, server/kernel.ts), so the reason is restated here
 * from the handler rather than dropped: `get_mandate` has exactly one
 * `forbidden` reason, `org_role_required`, and `loadMandateRow` exactly one
 * `not_found` reason, `mandate_not_found`. Both are traceable to a single throw
 * site, which is why they can be named from this side without guessing.
 */
function fromRead(
  read: Exclude<Read<unknown>, { ok: true }>,
): ActionResult<never> {
  switch (read.reason) {
    case "denied":
      return { ok: false, reason: "denied", code: "org_role_required" };
    case "pending_approval":
      return {
        ok: false,
        reason: "pending_approval",
        accessRequestId: read.accessRequestId,
      };
    case "error":
      return read.status === 404
        ? { ok: false, reason: "not_found", code: "mandate_not_found" }
        : { ok: false, reason: "unavailable", code: read.code };
  }
}

/**
 * Changes an active mandate's limits, and its validity end when one is given.
 *
 * **It reads the stored limits and lays the edit over them.**
 * `update_mandate_limits` sets `limits` to what the input carries, so a
 * submission naming one measure would delete the bounds on every other measure
 * the mandate holds — and a deleted bound is unbounded authority for that
 * measure. That is the failure class ARCHITECTURE.md §9 already records twice on
 * this lane: a form that can store a wider bound than the operator entered. So
 * the record is read first, the measures this submission edits are merged over
 * it, and every bound nobody touched goes back exactly as recorded.
 *
 * The consequence a person has to know about: a blank field leaves that measure's
 * bound as it is rather than removing it. Removing a limit entirely means sending
 * a `limits` record without it, which is `update_mandate_limits` over the API or
 * MCP; a form whose blank fields could delete bounds would delete them by
 * accident far more often than on purpose. The dialog's copy says so.
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

  // A mandate over the built-in measure alone is a legitimate shape, and the
  // only one available to a tool that carries a consequence and declares no
  // numeric measure: `mandateLimitsSchema` needs one limit and `calls` is one.
  const wantsMeasure =
    measure !== "" || unit !== "" || perCall !== "" || perPeriod !== "";
  if (!wantsMeasure && callsPerDay === "" && validTo === "")
    return refuse("perPeriod");

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
    if (unit === "" || isCurrencyCode(unit.toUpperCase())) return refuse("unit");
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

  /** The measures this submission edits, and only those. */
  const edited = {
    ...(wantsMeasure
      ? {
          [measure]: {
            ...(perCallValue === null ? {} : { perCall: perCallValue }),
            ...(perPeriodValue === null ? {} : { perPeriod: perPeriodValue }),
            period: draft.period,
            currencyOrUnit: unit,
          },
        }
      : {}),
    ...(callsPerDay === ""
      ? {}
      : {
          [RESERVED_MEASURE]: {
            perPeriod: callsPerDay,
            period: "daily" as const,
            currencyOrUnit: RESERVED_MEASURE,
          },
        }),
  };

  const ctx = await requireViewer(org, ws);

  // The merge. `update_mandate_limits` SETS `limits` to what it is given, so a
  // submission carrying only the measure this dialog exposes would delete every
  // other measure's bound — and deleting a bound widens the agent's authority
  // for that measure without anyone asking. The stored record is read first and
  // the edited measures are laid over it, so every bound nobody touched is
  // resubmitted exactly as recorded.
  //
  // It is read from the store rather than carried up from the page. The dialog
  // holds the mandate's authority and could reconstruct the record from it, but
  // then the bounds that go back would be the ones a client sent, and the whole
  // point of this call is that the unchanged ones are the ones the record holds.
  // `ledgerLimit: 1` because the movements are not wanted; the contract's floor
  // is 1 and the mandate is the only part of the answer this uses.
  let stored: StoredLimits = {};
  if (Object.keys(edited).length > 0) {
    const current = await kernelRead(ctx, {
      contract: mandateGet,
      input: { mandateId: draft.mandateId, ledgerLimit: 1 },
      page: "mandates",
    });
    if (!current.ok) return fromRead(current);
    stored = current.value.mandate.limits;
  }
  const limits: StoredLimits = { ...stored, ...edited };

  const result = await kernelWrite(ctx, mandateLimitsUpdate, {
    mandateId: draft.mandateId,
    // Omitted rather than sent empty: the contract refuses a `limits` record
    // with no measure in it, and a change to the window alone is a legal change.
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    // The last day a mandate may be drawn on runs through the end of that day,
    // so a window ending 2026-12-31 expires as that day ends, not as it begins.
    ...(validTo === "" ? {} : { validTo: `${validTo}T23:59:59.999Z` }),
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
    return { ok: false, reason: "invalid", code: "invalid_input", field: "reason" };
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
