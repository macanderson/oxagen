"use server";
// Grant a mandate from the Tools ledger (#2957; mockup `pTools` mandates tab,
// "Grant a mandate opens the mandate dialog"): a new active mandate, or the
// activation of a draft `request_mandate` recorded, through the kernel seam for
// the workspace viewer the URL names.
//
// **This action does not decide who may grant.** `grant_mandate` reads the
// workspace's `consequence_roles`, then calls `assertConsequenceRole` for every
// tag on the mandate before it touches a row
// (`packages/handlers/src/mandate.grant.ts`, INV-29). The satisfying role is
// recorded as `roleAtGrant`. A refusal comes back as `denied` with the handler's
// reason in `code`, and nothing is written.
//
// **Limits are written verbatim.** `mandateLimitsOf` holds the rule for both
// mandate forms: the figure typed is the figure stored, a currency unit is
// refused, and `calls` is written only by its own field. The same rule governs
// a `humanAbove` threshold here, since it is compared with the call's measure in
// the same stored units. A money limit is granted over the API or MCP by a
// caller that holds the tool's measure declaration.
import { mandateGrant } from "@oxagen/oxagen/contracts/mandate.grant";
import {
  CONSEQUENCE_TAG,
  MANDATE_APPROVER,
  MEASURE_NAME,
  MEASURE_VALUE,
  TARGET_MAX,
  consequenceTagsOf,
  listOf,
  mandateLimitsOf,
} from "@/data/contracts/mandates";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer, viewerTimeZone } from "@/server/viewer";
import {
  endOfZonedDay,
  isCalendarDay,
  startOfZonedDay,
} from "@/shared/calendar-day";

/** The fields the grant dialog collects, as typed. */
export type GrantDraft = {
  /** The agent's public id (`agt_…`), picked from the workspace's agents. */
  agentId: string;
  /** The draft this grant activates (`mnd_…`), or null for a new mandate. */
  requestId: string | null;
  /** Every consequence the covered tools declare, comma-separated. */
  consequenceTags: string;
  /** The measure the tool version declares the limit under; never `calls`. */
  measure: string;
  /** What that measure counts, in its own name. Never an ISO 4217 code. */
  unit: string;
  /** The limits as typed, in whole units of `unit`. Nothing here is scaled. */
  perCall: string;
  perPeriod: string;
  period: "daily" | "weekly" | "monthly";
  /** An optional cap on the built-in `calls` measure, per day. */
  callsPerDay: string;
  /** Tool patterns over `slug@version`, comma-separated. */
  tools: string;
  /** The measure a counterparty rule applies to; blank for no rule. */
  targetMeasure: string;
  /** Targets the measure may be drawn against, comma-separated. */
  targetAllow: string;
  /** Targets it may never be drawn against, comma-separated. */
  targetDeny: string;
  /** Consequences for which a person answers every call, comma-separated. */
  alwaysHumanFor: string;
  /** The measure a person looks above, and the threshold, in stored units. */
  humanAboveMeasure: string;
  humanAboveValue: string;
  /** Who may answer a parked call: `role:<org role>` or `user:<usr_…>`, comma-separated. */
  approvers: string;
  purpose: string;
  /** Dates as the date inputs give them (`YYYY-MM-DD`). */
  validFrom: string;
  validTo: string;
};

function refuse(field: keyof GrantDraft): ActionResult<never> {
  return { ok: false, reason: "invalid", code: "invalid_input", field };
}

/**
 * Grants an agent bounded, expiring authority for a consequence, or activates
 * the draft `requestId` names with this body. The handler replaces a draft's
 * body with the granter's, so the dialog sends the whole mandate either way.
 *
 * Every field is checked here against the contract bound it mirrors, so a
 * mistake is named on the field that made it rather than as a schema failure
 * that names none. Whether the tool patterns match a declared tool, and whether
 * those tools declare the limited and targeted measures, only the handler can
 * answer: it refuses both, and the dialog says which.
 */
export async function grantMandate(
  org: string,
  ws: string,
  draft: GrantDraft,
): Promise<ActionResult<{ mandateId: string; status: string }>> {
  const agentId = draft.agentId.trim();
  if (agentId === "") return refuse("agentId");

  const consequenceTags = consequenceTagsOf(draft.consequenceTags);
  if (consequenceTags === null) return refuse("consequenceTags");

  const limits = mandateLimitsOf(draft);
  if (!limits.ok) return refuse(limits.field);

  const tools = listOf(draft.tools);
  if (tools.length === 0) return refuse("tools");

  // One counterparty rule, keyed by the measure it reads the target from. The
  // handler refuses a targeted measure no covered tool declares, so a rule on a
  // measure the tools do not carry is named rather than stored as dead text.
  const targetMeasure = draft.targetMeasure.trim();
  const allow = [...new Set(listOf(draft.targetAllow))];
  const deny = [...new Set(listOf(draft.targetDeny))];
  const wantsTargets = allow.length > 0 || deny.length > 0;
  if (
    wantsTargets &&
    (targetMeasure === "calls" || !MEASURE_NAME.test(targetMeasure))
  )
    return refuse("targetMeasure");
  if (!wantsTargets && targetMeasure !== "") return refuse("targetAllow");
  if (allow.some((target) => target.length > TARGET_MAX))
    return refuse("targetAllow");
  if (deny.some((target) => target.length > TARGET_MAX))
    return refuse("targetDeny");

  const alwaysHumanFor = [...new Set(listOf(draft.alwaysHumanFor))];
  if (!alwaysHumanFor.every((tag) => CONSEQUENCE_TAG.test(tag)))
    return refuse("alwaysHumanFor");

  // The threshold is compared with the call's measure in the units the ledger
  // records, so it is written verbatim for the reason the limits are.
  const humanAboveMeasure = draft.humanAboveMeasure.trim();
  const humanAboveValue = draft.humanAboveValue.trim();
  if (humanAboveMeasure !== "" && humanAboveValue === "")
    return refuse("humanAboveValue");
  if (
    humanAboveValue !== "" &&
    (humanAboveMeasure === "" || !MEASURE_NAME.test(humanAboveMeasure))
  )
    return refuse("humanAboveMeasure");
  if (humanAboveValue !== "" && !MEASURE_VALUE.test(humanAboveValue))
    return refuse("humanAboveValue");

  const approvers = [...new Set(listOf(draft.approvers))];
  if (!approvers.every((entry) => MANDATE_APPROVER.test(entry)))
    return refuse("approvers");

  const purpose = draft.purpose.trim();
  if (purpose === "") return refuse("purpose");

  // Each day has to exist, not only look like one. `2027-02-31` matches the
  // shape and `startOfZonedDay` rolls it forward to 3 March, which for the end
  // of a window is three days of authority nobody granted (`isCalendarDay`).
  if (!isCalendarDay(draft.validFrom)) return refuse("validFrom");
  if (!isCalendarDay(draft.validTo)) return refuse("validTo");

  const ctx = await requireViewer(org, ws);
  // The days a person picks are days on their own clock, placed through their
  // saved zone. A zone that cannot be established refuses rather than falling
  // back, because a guessed zone moves an authority boundary by up to a day
  // (`requestMandate` and `server/viewer.ts` → `viewerTimeZone`).
  const zone = await viewerTimeZone(ctx, "tools");
  if (!zone.ok) return zone;
  const validFrom = startOfZonedDay(draft.validFrom, zone.timeZone);
  const validTo = endOfZonedDay(draft.validTo, zone.timeZone);
  if (validFrom === null) return refuse("validFrom");
  if (validTo === null) return refuse("validTo");
  if (Date.parse(validTo) <= Date.parse(validFrom)) return refuse("validTo");

  const requestId = draft.requestId?.trim() ?? "";
  const result = await kernelWrite(ctx, mandateGrant, {
    agentId,
    consequenceTags,
    limits: limits.limits,
    targets: wantsTargets ? { [targetMeasure]: { allow, deny } } : {},
    tools,
    approval: {
      humanAbove:
        humanAboveValue === "" ? {} : { [humanAboveMeasure]: humanAboveValue },
      alwaysHumanFor,
      approvers,
    },
    purpose,
    validFrom,
    validTo,
    ...(requestId === "" ? {} : { requestId }),
  });
  return result.ok
    ? {
        ok: true,
        value: { mandateId: result.value.id, status: result.value.status },
      }
    : result;
}
