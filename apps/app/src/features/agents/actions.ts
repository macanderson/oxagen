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
import { isCurrencyCode, microsFromDecimal } from "@/data/contracts/money";
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
  /** The measure the tool version declares the limit under (`amount`, `rows`). */
  measure: string;
  /**
   * What that measure counts, as the operator states it. No contract answers a
   * tool version's `measures` today, so the form cannot read the declaration
   * and must be told: an amount is scaled to micros against a currency, a
   * count is whole units of a named unit. Guessing would put a count of 50
   * into the ledger as 50,000,000.
   */
  kind: "amount" | "count";
  /** ISO 4217 for an amount; the unit's own name for a count. */
  currency: string;
  /** The limits as typed: a decimal for an amount, a whole number for a count. */
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

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE = /^\d{1,9}$/;
/** A count limit: whole units, up to what the measure-value regex admits. */
const WHOLE_UNITS = /^(0|[1-9][0-9]{0,29})$/;

/**
 * The one built-in measure (`CALLS_MEASURE`, packages/oxagen/src/mandates/
 * schemas.ts): every call draws exactly one of it, and the gate reads it that
 * way whatever a limit says. A money limit filed under that name would be
 * read as a ceiling of that many calls — $250 per call as 250,000,000 calls —
 * and the grant handler cannot catch it, because it exempts `calls` from the
 * measure a tool version must declare. The amount field refuses the name, and
 * the calls-per-day field is the only writer of that limit.
 */
const RESERVED_MEASURE = "calls";

function refuse(field: keyof MandateDraft): ActionResult<never> {
  return { ok: false, reason: "invalid", code: "invalid_input", field };
}

/**
 * Asks for a mandate on this agent's behalf. The handler records a draft for
 * the role accountable for the consequence to grant or decline; a draft grants
 * nothing, because the gate reads active mandates only.
 *
 * A limit is stored in the units the ledger records, and which those are
 * depends on what the measure counts: micros for an amount (INV-09), whole
 * units for a count. The operator states which, because no contract answers a
 * tool version's `measures` and the form would otherwise be choosing a scaling
 * for a value whose type it does not know — a count of 50 filed as 50,000,000
 * is a millionfold more authority than was asked for. A figure that is not of
 * the stated kind is refused before the kernel is called.
 */
export async function requestMandate(
  org: string,
  ws: string,
  draft: MandateDraft,
): Promise<ActionResult<{ mandateId: string; status: string }>> {
  const amount = draft.kind === "amount";
  const unit = amount
    ? draft.currency.trim().toUpperCase()
    : draft.currency.trim();
  // An amount is denominated in a currency, a count in a unit of its own; a
  // unit that is a currency code would make the two indistinguishable on the
  // read (`isCurrencyCode`), so each field admits only its own kind of name.
  if (amount ? !isCurrencyCode(unit) : unit === "" || isCurrencyCode(unit))
    return refuse("currency");
  const measure = draft.measure.trim();
  if (measure === "" || measure === RESERVED_MEASURE) return refuse("measure");
  const consequenceTag = draft.consequenceTag.trim();
  if (consequenceTag === "") return refuse("consequenceTag");

  /** A typed limit in the units the ledger records: micros, or whole units. */
  const limitValue = (typed: string): string | null =>
    amount
      ? microsFromDecimal(typed)
      : WHOLE_UNITS.test(typed)
        ? typed.replace(/^0+(?=\d)/, "")
        : null;

  const perCall = draft.perCall.trim();
  const perPeriod = draft.perPeriod.trim();
  if (perCall === "" && perPeriod === "") return refuse("perPeriod");
  const perCallValue = perCall === "" ? null : limitValue(perCall);
  if (perCall !== "" && perCallValue === null) return refuse("perCall");
  const perPeriodValue = perPeriod === "" ? null : limitValue(perPeriod);
  if (perPeriod !== "" && perPeriodValue === null) return refuse("perPeriod");

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
  // The dates a person picks are days, and the authority runs through the last
  // of them: a mandate valid to 2026-12-31 expires as that day ends, not as it
  // begins. The window is inclusive at both ends, so a single-day mandate is
  // a day rather than nothing.
  const validFrom = `${draft.validFrom}T00:00:00.000Z`;
  const validTo = `${draft.validTo}T23:59:59.999Z`;
  if (Date.parse(validTo) <= Date.parse(validFrom)) return refuse("validTo");

  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, mandateRequest, {
    agentId: draft.agentId,
    consequenceTags: [consequenceTag],
    limits: {
      [measure]: {
        ...(perCallValue === null ? {} : { perCall: perCallValue }),
        ...(perPeriodValue === null ? {} : { perPeriod: perPeriodValue }),
        period: draft.period,
        currencyOrUnit: unit,
      },
      ...(callsPerDay === ""
        ? {}
        : {
            [RESERVED_MEASURE]: {
              perPeriod: callsPerDay,
              period: "daily" as const,
              currencyOrUnit: RESERVED_MEASURE,
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
