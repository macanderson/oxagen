"use client";
// Grant a mandate (#2957; mockup `pTools` mandates tab, the `mandate` dialog):
// the accountable office gives one agent bounded, expiring authority for a
// consequence, or activates a draft an operator requested. Either way the
// dialog sends a whole mandate, because the handler replaces a draft's body
// with the granter's.
//
// The dialog opens in two ways. The ledger's header control starts blank, with
// an agent picked from the workspace's agents. A requested row's Grant control
// opens it on that draft: the agent is fixed, and every field the draft
// recorded is prefilled so the granter reviews the request rather than retyping
// it. A draft the form cannot hold whole is shown but not granted here
// (`notCarried`): the handler replaces a draft's body with the granter's, so a
// money limit, a second limit or rule, a calls limit the form cannot express,
// or a pattern its comma-separated fields would split would be dropped or
// widened, and the active mandate would grant more than was asked.
//
// The consequences are a set, as on the request: a mandate covers a tool only
// when it names every tag that tool declares. The counterparty rule and the
// approval rule are optional, and each is one rule. The contract takes a record
// of each, and a second rule is granted over the API or MCP.
import { useTimeZone, useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import {
  CONSEQUENCE_OTHER_MAX,
  MEASURE_NAME_MAX,
  PURPOSE_MAX,
  STARTER_CONSEQUENCE_TAGS,
  UNIT_MAX,
  listOf,
  type MandateRow,
  type MeasureValue,
} from "@/data/contracts/mandates";
import {
  chooseAgents,
  chooseApprovers,
  chooseToolPatterns,
} from "@/features/shell/client";
import { routes } from "@/shared/safe-path";
import { buttonSecondary, inputBase, mono } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { RecordMultiPicker, RecordPicker } from "@/ui/record-picker";
import { SheetDialog } from "@/ui/sheet-dialog";
import { type GrantDraft, grantMandate } from "./grant-actions";
import { UNANSWERED, useGrantFailure } from "./grant-failure";
import { carriedBy, type ToolsAt } from "./view";

const TESTID = "grant-mandate";

const PERIODS = ["daily", "weekly", "monthly"] as const;

const CONSEQUENCE_TAGS = STARTER_CONSEQUENCE_TAGS;

/** The tags `alwaysHumanFor` offers; a tag the workspace added can be typed. */
const TAG_OPTIONS = CONSEQUENCE_TAGS.map((tag) => ({ value: tag, label: tag }));

/** An agent the picker offers: a retired identity is never one (see `grantableAgents` in tools.tsx). */
type GrantableAgent = { id: string; slug: string; name: string };

/** What the picker has to offer, and whether that is every agent. */
export type AgentChoices =
  | { ok: true; agents: readonly GrantableAgent[]; partial: boolean }
  | { ok: false };

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** The ticked boxes under `name`. A checkbox never yields a File, but FormData's type allows one. */
function chosen(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .filter((value): value is string => typeof value === "string");
}

function period(form: FormData): GrantDraft["period"] {
  const raw = text(form, "period");
  return PERIODS.find((p) => p === raw) ?? "monthly";
}

/** `YYYY-MM-DD` for the day `instant` falls on in `timeZone`, as a date input takes it. */
function dayIn(instant: string, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

type Prefill = {
  tags: readonly string[];
  otherTags: string;
  measure: string;
  unit: string;
  perCall: string;
  perPeriod: string;
  period: GrantDraft["period"];
  callsPerDay: string;
  tools: string;
  targetMeasure: string;
  targetAllow: string;
  targetDeny: string;
  alwaysHumanFor: string;
  humanAboveMeasure: string;
  humanAboveValue: string;
  approvers: string;
  purpose: string;
  validFrom: string;
  validTo: string;
};

const BLANK: Prefill = {
  tags: [],
  otherTags: "",
  measure: "",
  unit: "",
  perCall: "",
  perPeriod: "",
  period: "monthly",
  callsPerDay: "",
  tools: "",
  targetMeasure: "",
  targetAllow: "",
  targetDeny: "",
  alwaysHumanFor: "",
  humanAboveMeasure: "",
  humanAboveValue: "",
  approvers: "",
  purpose: "",
  validFrom: "",
  validTo: "",
};

/**
 * True when submitting this form would drop or alter part of `request`. The
 * form holds one count limit, a calls limit per day with no per-call figure,
 * one counterparty rule and one `humanAbove` threshold. A money figure is
 * micros and this form writes whole units, so it cannot carry one either. Its
 * tool patterns and target globs are comma-separated fields, and each stored
 * value is free text of up to 256 characters, so one that contains a comma
 * comes back as two: `vendor:*,prod` becomes `vendor:*` and `prod`, and the
 * first admits every vendor target the requester never named. Because
 * `grant_mandate` replaces the draft's body with what the form sends, granting
 * such a draft here would activate a mandate other than the one requested: a
 * dropped limit or threshold, or a split pattern, is authority nobody approved.
 */
function notCarried(request: MandateRow): boolean {
  const limits = request.authority.filter((entry) => entry.measure !== "calls");
  const calls = request.authority.find((entry) => entry.measure === "calls");
  const whole = (values: readonly string[]) => carriedBy(values, ", ", listOf);
  return (
    limits.length > 1 ||
    limits.some(
      (entry) =>
        entry.perCall?.kind === "money" || entry.perPeriod?.kind === "money",
    ) ||
    (calls !== undefined &&
      (calls.period !== "daily" || calls.perCall !== null)) ||
    request.targets.length > 1 ||
    request.approval.humanAbove.length > 1 ||
    !whole(request.tools) ||
    request.targets.some(
      (target) => !whole(target.allow) || !whole(target.deny),
    )
  );
}

/**
 * The fields a requested draft opens with. Only a count limit is carried: a
 * money figure is micros and this form writes whole units, so prefilling one
 * would grant a millionth of what was asked, or, typed back as the dollars it
 * reads as, a figure nobody meant. A draft with more than the form holds is
 * refused by `notCarried` rather than prefilled in part.
 */
function prefillOf(request: MandateRow, timeZone: string | undefined): Prefill {
  const countOf = (value: MeasureValue | null): string =>
    value?.kind === "count" ? value.count : "";
  const counted = request.authority.find(
    (entry) =>
      entry.measure !== "calls" &&
      (entry.perPeriod?.kind === "count" || entry.perCall?.kind === "count"),
  );
  const countedUnit =
    counted?.perPeriod?.kind === "count"
      ? counted.perPeriod.unit
      : counted?.perCall?.kind === "count"
        ? counted.perCall.unit
        : "";
  const calls = request.authority.find((entry) => entry.measure === "calls");
  const target = request.targets[0];
  const threshold = request.approval.humanAbove[0];
  const starter: readonly string[] = CONSEQUENCE_TAGS;
  return {
    tags: request.consequenceTags.filter((tag) => starter.includes(tag)),
    otherTags: request.consequenceTags
      .filter((tag) => !starter.includes(tag))
      .join(", "),
    measure: counted?.measure ?? "",
    unit: countedUnit,
    perCall: countOf(counted?.perCall ?? null),
    perPeriod: countOf(counted?.perPeriod ?? null),
    period: PERIODS.find((p) => p === counted?.period) ?? "monthly",
    callsPerDay: countOf(calls?.perPeriod ?? null),
    tools: request.tools.join(", "),
    targetMeasure: target?.measure ?? "",
    targetAllow: target?.allow.join(", ") ?? "",
    targetDeny: target?.deny.join(", ") ?? "",
    alwaysHumanFor: request.approval.alwaysHumanFor.join(", "),
    humanAboveMeasure: threshold?.measure ?? "",
    humanAboveValue: threshold?.recorded ?? "",
    approvers: request.approval.approvers.join(", "),
    purpose: request.purpose,
    validFrom: dayIn(request.validFrom, timeZone),
    validTo: dayIn(request.validTo, timeZone),
  };
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  /** The id of the control this labels. */
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm text-foreground">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export function GrantMandate({
  at,
  agents,
  request = null,
}: {
  at: ToolsAt;
  /** The agents the picker offers; unused when a request fixes the agent. */
  agents: AgentChoices;
  /** The draft this grant activates, or null for a new mandate. */
  request?: MandateRow | null;
}) {
  const t = useTranslations("tools.grant");
  const label = useTranslations("tools.grant.fields");
  const failureText = useGrantFailure();
  const navigate = useNavigate();
  const timeZone = useTimeZone();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /** A new mandate needs an agent to bind to; without one there is nothing to submit. */
  const canPick = request !== null || (agents.ok && agents.agents.length > 0);
  const testId = request === null ? TESTID : `${TESTID}-${request.id}`;
  // Ids carry the dialog's own test id: the ledger mounts one dialog per
  // requested row beside the header's, and two labels may not share a target.
  const id = (name: string) => `${testId}-${name}`;
  /** A draft this form cannot hold whole: shown for review, never granted here. */
  const refused = request !== null && notCarried(request);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || refused) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const result = await grantMandate(at.org, at.ws, {
        agentId: request === null ? text(form, "agentId") : request.agentId,
        requestId: request === null ? null : request.id,
        consequenceTags: [
          ...chosen(form, "consequenceTags"),
          text(form, "consequenceOther"),
        ]
          .filter((tag) => tag !== "")
          .join(","),
        measure: text(form, "measure"),
        unit: text(form, "unit"),
        perCall: text(form, "perCall"),
        perPeriod: text(form, "perPeriod"),
        period: period(form),
        callsPerDay: text(form, "callsPerDay"),
        tools: text(form, "tools"),
        targetMeasure: text(form, "targetMeasure"),
        targetAllow: text(form, "targetAllow"),
        targetDeny: text(form, "targetDeny"),
        alwaysHumanFor: text(form, "alwaysHumanFor"),
        humanAboveMeasure: text(form, "humanAboveMeasure"),
        humanAboveValue: text(form, "humanAboveValue"),
        approvers: text(form, "approvers"),
        purpose: text(form, "purpose"),
        validFrom: text(form, "validFrom"),
        validTo: text(form, "validTo"),
      });
      if (result.ok) {
        setOpen(false);
        navigate.replace(routes.tools(at.org, at.ws, { tab: "policy" }));
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  // Read when the dialog renders, so reopening it on a fresher ledger reads the
  // draft again; `defaultValue` seeds each field once per mount.
  const prefill = request === null ? BLANK : prefillOf(request, timeZone);

  return (
    <>
      <button
        type="button"
        className={buttonSecondary}
        data-testid={`${testId}-open`}
        aria-label={
          request === null
            ? undefined
            : t("grantRequestLabel", { id: request.id })
        }
        onClick={() => {
          setOpen(true);
        }}
      >
        {request === null ? t("open") : t("grantRequest")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={request === null ? t("title") : t("titleRequest")}
        subtitle={request === null ? undefined : request.id}
        testId={testId}
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {request === null ? t("body") : t("bodyRequest")}
          </p>
          {refused ? (
            <p data-state="not-carried" className="text-sm text-foreground">
              {t("notCarried")}
            </p>
          ) : null}
          {request !== null ? (
            <div className="flex flex-col gap-1 text-sm text-foreground">
              <span>{label("agentId")}</span>
              <span className={mono} data-testid={`${testId}-agent`}>
                {request.agentSlug}
              </span>
            </div>
          ) : !agents.ok ? (
            <p
              data-state="agents-unavailable"
              className="text-sm text-foreground"
            >
              {t("agentsUnavailable")}
            </p>
          ) : agents.agents.length === 0 ? (
            <p data-state="agents-empty" className="text-sm text-foreground">
              {t("agentsEmpty")}
            </p>
          ) : (
            <Field id={id("agentId")} label={label("agentId")}>
              {/* The page holds the first page of agents. When there are
                  more, the picker reads every page the first time it opens. */}
              <RecordPicker
                id={id("agentId")}
                name="agentId"
                required
                {...(agents.partial
                  ? { load: () => chooseAgents(at.org, at.ws) }
                  : {
                      options: agents.agents.map((agent) => ({
                        value: agent.id,
                        label: agent.name,
                        detail: agent.slug,
                      })),
                    })}
              />
            </Field>
          )}
          <fieldset className="flex flex-col gap-1 text-sm text-foreground">
            <legend>{label("consequenceTags")}</legend>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {CONSEQUENCE_TAGS.map((tag) => (
                <label
                  key={tag}
                  htmlFor={id(`consequence-${tag}`)}
                  className="flex items-center gap-1.5"
                >
                  <input
                    id={id(`consequence-${tag}`)}
                    type="checkbox"
                    name="consequenceTags"
                    value={tag}
                    defaultChecked={prefill.tags.includes(tag)}
                  />
                  {tag}
                </label>
              ))}
            </div>
            <label
              htmlFor={id("consequenceOther")}
              className="mt-1 text-xs text-muted-foreground"
            >
              {t("consequenceOther")}
            </label>
            <input
              id={id("consequenceOther")}
              name="consequenceOther"
              maxLength={CONSEQUENCE_OTHER_MAX}
              defaultValue={prefill.otherTags}
              className={inputBase}
            />
            <p className="text-xs text-muted-foreground">
              {t("consequenceTagsHint")}
            </p>
          </fieldset>
          <Field id={id("tools")} label={label("tools")} hint={t("toolsHint")}>
            <RecordMultiPicker
              id={id("tools")}
              name="tools"
              required
              freeform
              load={() => chooseToolPatterns(at.org, at.ws)}
              defaultValue={listOf(prefill.tools)}
            />
          </Field>
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-foreground">
              {t("limits")}
            </legend>
            <p className="text-xs text-muted-foreground">{t("limitsHint")}</p>
            <Field
              id={id("measure")}
              label={label("measure")}
              hint={t("measureHint")}
            >
              <input
                id={id("measure")}
                name="measure"
                maxLength={MEASURE_NAME_MAX}
                defaultValue={prefill.measure}
                className={inputBase}
              />
            </Field>
            <Field id={id("unit")} label={label("unit")} hint={t("unitHint")}>
              <input
                id={id("unit")}
                name="unit"
                maxLength={UNIT_MAX}
                defaultValue={prefill.unit}
                className={inputBase}
              />
            </Field>
            <Field id={id("perCall")} label={label("perCall")}>
              <input
                id={id("perCall")}
                name="perCall"
                inputMode="numeric"
                defaultValue={prefill.perCall}
                className={inputBase}
              />
            </Field>
            <Field
              id={id("perPeriod")}
              label={label("perPeriod")}
              hint={t("perPeriodHint")}
            >
              <input
                id={id("perPeriod")}
                name="perPeriod"
                inputMode="numeric"
                defaultValue={prefill.perPeriod}
                className={inputBase}
              />
            </Field>
            <Field id={id("period")} label={t("period")}>
              <select
                id={id("period")}
                name="period"
                defaultValue={prefill.period}
                className={inputBase}
              >
                {PERIODS.map((value) => (
                  <option key={value} value={value}>
                    {t(`periods.${value}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id={id("callsPerDay")} label={label("callsPerDay")}>
              <input
                id={id("callsPerDay")}
                name="callsPerDay"
                inputMode="numeric"
                defaultValue={prefill.callsPerDay}
                className={inputBase}
              />
            </Field>
          </fieldset>
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-foreground">
              {t("targets")}
            </legend>
            <p className="text-xs text-muted-foreground">{t("targetsHint")}</p>
            <Field id={id("targetMeasure")} label={label("targetMeasure")}>
              <input
                id={id("targetMeasure")}
                name="targetMeasure"
                maxLength={MEASURE_NAME_MAX}
                defaultValue={prefill.targetMeasure}
                className={inputBase}
              />
            </Field>
            <Field id={id("targetAllow")} label={label("targetAllow")}>
              <input
                id={id("targetAllow")}
                name="targetAllow"
                defaultValue={prefill.targetAllow}
                className={inputBase}
              />
            </Field>
            <Field id={id("targetDeny")} label={label("targetDeny")}>
              <input
                id={id("targetDeny")}
                name="targetDeny"
                defaultValue={prefill.targetDeny}
                className={inputBase}
              />
            </Field>
          </fieldset>
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium text-foreground">
              {t("approval")}
            </legend>
            <p className="text-xs text-muted-foreground">{t("approvalHint")}</p>
            <Field
              id={id("alwaysHumanFor")}
              label={label("alwaysHumanFor")}
              hint={t("alwaysHumanForHint")}
            >
              <RecordMultiPicker
                id={id("alwaysHumanFor")}
                name="alwaysHumanFor"
                freeform
                options={TAG_OPTIONS}
                defaultValue={listOf(prefill.alwaysHumanFor)}
              />
            </Field>
            <Field
              id={id("humanAboveMeasure")}
              label={label("humanAboveMeasure")}
            >
              <input
                id={id("humanAboveMeasure")}
                name="humanAboveMeasure"
                maxLength={MEASURE_NAME_MAX}
                defaultValue={prefill.humanAboveMeasure}
                className={inputBase}
              />
            </Field>
            <Field
              id={id("humanAboveValue")}
              label={label("humanAboveValue")}
              hint={t("humanAboveValueHint")}
            >
              <input
                id={id("humanAboveValue")}
                name="humanAboveValue"
                inputMode="numeric"
                defaultValue={prefill.humanAboveValue}
                className={inputBase}
              />
            </Field>
            <Field
              id={id("approvers")}
              label={label("approvers")}
              hint={t("approversHint")}
            >
              <RecordMultiPicker
                id={id("approvers")}
                name="approvers"
                freeform
                load={() => chooseApprovers(at.org)}
                defaultValue={listOf(prefill.approvers)}
              />
            </Field>
          </fieldset>
          <Field
            id={id("purpose")}
            label={label("purpose")}
            hint={t("purposeHint")}
          >
            <textarea
              id={id("purpose")}
              name="purpose"
              required
              maxLength={PURPOSE_MAX}
              rows={2}
              defaultValue={prefill.purpose}
              className={inputBase}
            />
          </Field>
          <Field id={id("validFrom")} label={label("validFrom")}>
            <input
              id={id("validFrom")}
              name="validFrom"
              type="date"
              required
              defaultValue={prefill.validFrom}
              className={inputBase}
            />
          </Field>
          <Field
            id={id("validTo")}
            label={label("validTo")}
            hint={t("validToHint")}
          >
            <input
              id={id("validTo")}
              name="validTo"
              type="date"
              required
              defaultValue={prefill.validTo}
              className={inputBase}
            />
          </Field>
          {failure === null ? null : (
            <FormAlert testId={`${testId}-failure`}>{failure}</FormAlert>
          )}
          {canPick && !refused ? (
            <SubmitButton
              pending={pending}
              label={request === null ? t("confirm") : t("confirmRequest")}
              pendingLabel={t("pending")}
            />
          ) : null}
        </form>
      </SheetDialog>
    </>
  );
}
