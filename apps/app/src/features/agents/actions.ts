"use server";
// The writes on an agent identity (#2956; ADR-057 decision 3) and on its
// definition file (ADR-057 decision 1), each through the kernel seam for the
// workspace viewer the URL names. Every contract here is `noBillingGate` and
// role-checked in its handler (INV-29): rotate, suspend and retire by an org
// Owner or Admin, commit by an Owner, Admin or Member; a refusal comes back as
// `denied` with nothing changed. request_mandate (#2957) joins them: an agent
// operator asks for authority and the accountable role decides.
import { agentCredentialRotate } from "@oxagen/oxagen/contracts/agent.credential.rotate";
import { agentDefinitionCommit } from "@oxagen/oxagen/contracts/agent.definition.commit";
import { agentRetire } from "@oxagen/oxagen/contracts/agent.retire";
import { agentSuspend } from "@oxagen/oxagen/contracts/agent.suspend";
import { mandateRequest } from "@oxagen/oxagen/contracts/mandate.request";
import { microsFromDecimal } from "@/data/contracts/money";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/** Retires the current key and mints a replacement; the secret is returned once and never again. */
export async function rotateAgentCredential(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<{ secret: string; expiresAt: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentCredentialRotate, { agentId });
  return result.ok
    ? {
        ok: true,
        value: {
          secret: result.value.credential.secret,
          expiresAt: result.value.credential.expiresAt,
        },
      }
    : result;
}

/** Suspends the agent, or resumes a suspended one when `suspended` is false. */
export async function setAgentSuspended(
  org: string,
  ws: string,
  agentId: string,
  suspended: boolean,
): Promise<ActionResult<{ status: "suspended" | "active" }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentSuspend, { agentId, suspended });
  return result.ok
    ? { ok: true, value: { status: result.value.status } }
    : result;
}

/** Retires the identity: its runs keep it, its credentials and host enrollments are revoked. */
export async function retireAgent(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<{ retiredAt: string }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentRetire, { agentId });
  return result.ok
    ? { ok: true, value: { retiredAt: result.value.retiredAt } }
    : result;
}

export type DefinitionDraft = {
  agentId: string;
  branch: string;
  /** The commit and pull request title; blank leaves it to the handler. */
  message: string;
  source: string;
};

/** Commits the file to `branch` (never the default branch) and opens, or reuses, its pull request. */
export async function commitAgentDefinition(
  org: string,
  ws: string,
  draft: DefinitionDraft,
): Promise<
  ActionResult<{
    branch: string;
    commitSha: string;
    pullRequest: { number: number; url: string };
  }>
> {
  const ctx = await requireViewer(org, ws);
  const message = draft.message.trim();
  const result = await kernelWrite(ctx, agentDefinitionCommit, {
    agentId: draft.agentId,
    branch: draft.branch.trim(),
    source: draft.source,
    ...(message === "" ? {} : { message }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          branch: result.value.branch,
          commitSha: result.value.commitSha,
          pullRequest: result.value.pullRequest,
        },
      }
    : result;
}

/** The fields a mandate request carries, as the dialog collects them. */
export type MandateDraft = {
  agentId: string;
  /** The consequence the mandate answers for (`moves_money`). */
  consequenceTag: string;
  /** The measure the tool version declares the amount under (`amount`). */
  measure: string;
  /** ISO 4217, the currency the limits are named in. */
  currency: string;
  /** Decimal amounts as typed; at least one of the two is required. */
  perCall: string;
  perPeriod: string;
  period: "daily" | "weekly" | "monthly";
  /** An optional cap on the built-in `calls` measure, per day. */
  callsPerDay: string;
  /** Tool patterns over `slug@version`, comma-separated. */
  tools: string;
  purpose: string;
  /** Dates as the date inputs give them (`YYYY-MM-DD`). */
  validFrom: string;
  validTo: string;
};

const CURRENCY = /^[A-Za-z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE = /^\d{1,9}$/;

function refuse(field: keyof MandateDraft): ActionResult<never> {
  return { ok: false, reason: "invalid", code: "invalid_input", field };
}

/**
 * Asks for a mandate on this agent's behalf. The handler records a draft for
 * the role accountable for the consequence to grant or decline; a draft grants
 * nothing, because the gate reads active mandates only. Amounts are converted
 * to micros here (INV-09) and a figure that is not a plain decimal is refused
 * before the kernel is called.
 */
export async function requestMandate(
  org: string,
  ws: string,
  draft: MandateDraft,
): Promise<ActionResult<{ mandateId: string; status: string }>> {
  const currency = draft.currency.trim().toUpperCase();
  if (!CURRENCY.test(currency)) return refuse("currency");
  const measure = draft.measure.trim();
  if (measure === "") return refuse("measure");
  const consequenceTag = draft.consequenceTag.trim();
  if (consequenceTag === "") return refuse("consequenceTag");

  const perCall = draft.perCall.trim();
  const perPeriod = draft.perPeriod.trim();
  if (perCall === "" && perPeriod === "") return refuse("perPeriod");
  const perCallMicros = perCall === "" ? null : microsFromDecimal(perCall);
  if (perCall !== "" && perCallMicros === null) return refuse("perCall");
  const perPeriodMicros =
    perPeriod === "" ? null : microsFromDecimal(perPeriod);
  if (perPeriod !== "" && perPeriodMicros === null) return refuse("perPeriod");

  const callsPerDay = draft.callsPerDay.trim();
  if (callsPerDay !== "" && !WHOLE.test(callsPerDay))
    return refuse("callsPerDay");

  const tools = draft.tools
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "");
  if (tools.length === 0) return refuse("tools");

  const purpose = draft.purpose.trim();
  if (purpose === "") return refuse("purpose");

  if (!DATE.test(draft.validFrom)) return refuse("validFrom");
  if (!DATE.test(draft.validTo)) return refuse("validTo");
  const validFrom = `${draft.validFrom}T00:00:00.000Z`;
  const validTo = `${draft.validTo}T00:00:00.000Z`;
  if (Date.parse(validTo) <= Date.parse(validFrom)) return refuse("validTo");

  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, mandateRequest, {
    agentId: draft.agentId,
    consequenceTags: [consequenceTag],
    limits: {
      [measure]: {
        ...(perCallMicros === null ? {} : { perCall: perCallMicros }),
        ...(perPeriodMicros === null ? {} : { perPeriod: perPeriodMicros }),
        period: draft.period,
        currencyOrUnit: currency,
      },
      ...(callsPerDay === ""
        ? {}
        : {
            calls: {
              perPeriod: callsPerDay,
              period: "daily" as const,
              currencyOrUnit: "calls",
            },
          }),
    },
    targets: {},
    tools,
    approval: { humanAbove: {}, alwaysHumanFor: [], approvers: [] },
    purpose,
    validFrom,
    validTo,
  });
  return result.ok
    ? {
        ok: true,
        value: { mandateId: result.value.id, status: result.value.status },
      }
    : result;
}
