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
import {
  CONSEQUENCE_TAG,
  MAX_CONSEQUENCE_TAGS,
  MEASURE_VALUE,
} from "@/data/contracts/mandates";
import { isCurrencyCode } from "@/data/contracts/money";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer, viewerTimeZone } from "@/server/viewer";
import { endOfZonedDay, startOfZonedDay } from "@/shared/calendar-day";

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
  /**
   * The consequences the mandate answers for, comma-separated. A mandate must
   * name **every** tag each covered tool declares or it authorizes none of
   * them (`findCoveringMandate`), so this is a set the operator states and not
   * a single choice — and not a closed one either: the starter six are a
   * starting point the workspace extends, and a tool declaring a tag of its
   * own must be nameable or it can never be given a mandate.
   */
  consequenceTags: string;
  /** The measure the tool version declares the limit under (`rows`, `recipients`). */
  measure: string;
  /**
   * What that measure counts, in its own name (`rows`, `recipients`). Never an
   * ISO 4217 code: this form writes counts and only counts, for the reason
   * `requestMandate` gives.
   */
  unit: string;
  /** The limits as typed, in whole units of `unit`. Nothing here is scaled. */
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

/**
 * The day a date input gives. Deliberately narrower than the contract, which
 * takes an instant: the form collects days and widens each to the start and the
 * end of its own, so the window is inclusive at both ends. Every other bound
 * this action applies is a mirror of a contract rule and lives beside its rule
 * in `data/contracts/mandates.ts`.
 */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The one built-in measure (`CALLS_MEASURE`, packages/oxagen/src/mandates/
 * schemas.ts): every call draws exactly one of it, and the gate reads it that
 * way whatever a limit says. So a limit on anything else filed under that name
 * stops measuring what it names — 50 rows per period becomes a ceiling of 50
 * calls — and the grant handler cannot catch it, because it exempts `calls`
 * from the measure a tool version must declare. The measure field refuses the
 * name, and the calls-per-day field is the only writer of that limit.
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
 * **This form never multiplies a limit.** A limit is stored in the units the
 * ledger records, and which those are is a property of the tool version's
 * declaration, not of the request: micros for an `amount`, whole units for a
 * `count` (INV-09). The gate reads the call by that declaration — `readMeasure`
 * in packages/rules/src/mandates/measures.ts converts an amount to micros and
 * takes a count as whole units — and compares it against the stored limit as
 * an integer.
 *
 * The declaration is not reachable from here, and nothing downstream catches a
 * request that disagrees with it. `measureDeclarationsSchema` is an input of
 * `publish_tool_declaration` and appears in no output; `list_tool_declarations`
 * answers the version and checksum and no `measures`; `get_agent_toolbelt`
 * carries none; and reading `agent.tool_versions` is banned (INV-05).
 * `assertToolsDeclareMeasures` (packages/handlers/src/_mandate.ts) refuses a
 * measure that is undeclared or `text` and never compares its `type` to
 * anything the request states, so a grant does not check the scaling either.
 *
 * Being wrong in the two directions is not symmetric, which is what decides
 * this:
 *
 *   scaled, declared a `count`   50 stored as 50000000, read as 50,000,000
 *                                counts — a millionfold MORE authority than
 *                                was typed, silently.
 *   verbatim, declared an `amount`  50 stored as "50", read as 50 micros — a
 *                                millionfold LESS. The call is denied and a
 *                                person sees it.
 *
 * Only the first is a silent over-grant, and a mandate is bounded authority: a
 * form that can store a wider bound than the operator entered is a worse
 * failure than a form that cannot express every bound. So the figure typed is
 * the figure stored, digit for digit. A money limit is correct only once the
 * declaration confirms the measure is an `amount`, so it is not requestable
 * here — it is requestable over the API and MCP, where the caller holds the
 * declaration, and the app reads one back as money either way.
 *
 * The durable fix is `measures` on `list_tool_declarations`' output: with it
 * the form resolves the declaration for the named measure across the tools its
 * patterns match, defaults from it, refuses a mismatch, and can scale an
 * amount because it knows it is one. That is `list_tool_declarations`' object
 * and not this lane's (ARCHITECTURE.md §9).
 */
export async function requestMandate(
  org: string,
  ws: string,
  draft: MandateDraft,
): Promise<ActionResult<{ mandateId: string; status: string }>> {
  const unit = draft.unit.trim();
  const measure = draft.measure.trim();
  // `findCoveringMandate` (packages/rules/src/mandates.ts) accepts a mandate
  // only when `tool.consequenceTags.every(t => mandate.consequenceTags.includes(t))`,
  // so a mandate naming one tag of a tool that declares two covers nothing —
  // granted exactly as asked, and every call still denied, at the moment of use
  // and far from here. The form therefore writes the whole set the operator
  // names rather than a single tag. It cannot check the set against the tools:
  // `consequence_tags` lives on `agent.tool_versions` and appears in exactly
  // one contract, `publish_tool_declaration`, as an input — the same wall the
  // measure declaration is behind (INV-05). Naming too few is the safe way to
  // be wrong here, since the mandate then covers nothing rather than more than
  // was meant, and the gate's denial names the tags it wanted.
  const consequenceTags = [
    ...new Set(
      draft.consequenceTags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
    ),
  ];
  if (
    consequenceTags.length === 0 ||
    consequenceTags.length > MAX_CONSEQUENCE_TAGS ||
    !consequenceTags.every((tag) => CONSEQUENCE_TAG.test(tag))
  )
    return refuse("consequenceTags");

  // Verbatim: `MEASURE_VALUE` admits "0" and a figure with no leading zero, so
  // what passes is already the digits the ledger records and there is nothing
  // to normalise. The figure typed is the figure stored.
  const limitValue = (typed: string): string | null =>
    MEASURE_VALUE.test(typed) ? typed : null;

  const perCall = draft.perCall.trim();
  const perPeriod = draft.perPeriod.trim();
  // The same rule as any other limit, because it is one: `calls` is a measure
  // limit and `measureValueSchema` governs its figure. A nine-digit cap here
  // refused a ceiling of a billion calls that the ledger would have held.
  const callsPerDay = draft.callsPerDay.trim();
  if (callsPerDay !== "" && !MEASURE_VALUE.test(callsPerDay))
    return refuse("callsPerDay");

  // A mandate over the built-in measure alone is a legitimate shape and the
  // only one available for a tool that carries a consequence and declares no
  // numeric measure: `mandateLimitsSchema` needs one limit and `calls` is one,
  // and `assertToolsDeclareMeasures` exempts it from the declared-measure
  // check for exactly that reason. Requiring a measure limit as well shut that
  // tool out entirely — blank fields refused here, an invented measure refused
  // by the handler — so the measure entry is written only when it is asked
  // for, and the four fields that make it stand or fall together.
  const wantsMeasure =
    measure !== "" || unit !== "" || perCall !== "" || perPeriod !== "";
  if (!wantsMeasure && callsPerDay === "") return refuse("perPeriod");

  let perCallValue: string | null = null;
  let perPeriodValue: string | null = null;
  if (wantsMeasure) {
    if (measure === "" || measure === RESERVED_MEASURE)
      return refuse("measure");
    // A limit denominated in an ISO 4217 code reads back as money
    // (`isCurrencyCode`, src/data/contracts/money.ts) while the figure beside
    // it is whole units — the one shape this form must not write, since it is
    // the shape it cannot scale. Refusing the code keeps the write and the
    // read agreed: every limit this form writes is a count and reads back as
    // one. The membership test is on the upper-cased name so that "usd" is
    // refused beside "USD": an operator who meant money means it in either
    // casing, and the refusal has to reach them both times. The unit itself is
    // stored as typed.
    if (unit === "" || isCurrencyCode(unit.toUpperCase()))
      return refuse("unit");
    if (perCall === "" && perPeriod === "") return refuse("perPeriod");
    perCallValue = perCall === "" ? null : limitValue(perCall);
    if (perCall !== "" && perCallValue === null) return refuse("perCall");
    perPeriodValue = perPeriod === "" ? null : limitValue(perPeriod);
    if (perPeriod !== "" && perPeriodValue === null) return refuse("perPeriod");
  }

  const tools = draft.tools
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "");
  if (tools.length === 0) return refuse("tools");

  const purpose = draft.purpose.trim();
  if (purpose === "") return refuse("purpose");

  if (!DATE.test(draft.validFrom)) return refuse("validFrom");
  if (!DATE.test(draft.validTo)) return refuse("validTo");

  const ctx = await requireViewer(org, ws);
  // The dates a person picks are days on their clock. Convert through the
  // saved zone so a Los Angeles Sep 20 starts at that local midnight and a
  // Tokyo validTo runs through that local day's last millisecond.
  //
  // The zone is read here, in the `"use server"` module that resolved the
  // viewer, and not down in `data/live` — a port implementation has no viewer
  // and no business asking who is looking (ARCHITECTURE.md §2). An on-demand
  // read from an action goes through the kernel seam exactly as its write does
  // (ADR-089), like the Workspace settings dialog's.
  //
  // A zone that cannot be established refuses; it does not fall back. The pages
  // do fall back to Pacific, because a date drawn in the wrong zone is a
  // cosmetic error a reader can see. A validity boundary written in the wrong
  // zone is not: for an operator in Tokyo, Pacific moves the end of their day 17
  // hours later, and nothing afterwards says the zone was guessed
  // (`server/viewer.ts` → `viewerTimeZone`).
  const zone = await viewerTimeZone(ctx, "agents");
  if (!zone.ok) return zone;
  const validFrom = startOfZonedDay(draft.validFrom, zone.timeZone);
  const validTo = endOfZonedDay(draft.validTo, zone.timeZone);
  if (validFrom === null) return refuse("validFrom");
  if (validTo === null) return refuse("validTo");
  if (Date.parse(validTo) <= Date.parse(validFrom)) return refuse("validTo");

  const result = await kernelWrite(ctx, mandateRequest, {
    agentId: draft.agentId,
    consequenceTags,
    limits: {
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
