"use client";
// Request a mandate (#2957; mockup's `mandate` dialog, the request half): an
// agent's operator asks for bounded, expiring authority and the role
// accountable for the consequence grants or declines it. The dialog writes a
// draft, and a draft grants nothing.
//
// A mandate expires: there is no unbounded option, so both dates are required,
// and the window runs through the end of the last day. The figure is read from
// a call by the measure the tool version declares, so the measure is named here
// rather than guessed; a tool version that exposes no such measure cannot be
// given a mandate and the handler refuses the draft. The measure cannot be
// `calls`, which the field below writes and the gate reads as one per call.
//
// A mandate covers a tool only when it names every consequence that tool
// declares, so the consequences are a set rather than a choice: naming one of
// a tool's two mints a mandate that is granted as asked and authorizes nothing,
// and the failure shows up at the moment of use, far from here.
//
// Every limit here is whole units and is stored exactly as typed. Scaling one
// to micros is correct only for a measure the tool declares as an `amount`, and
// no contract answers a tool version's `measures` — so this form does not
// scale, and a money limit is asked for over the API or MCP by a caller that
// holds the declaration. `requestMandate` in actions.ts carries the reasoning.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import { buttonSecondary, inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { routes } from "@/shared/safe-path";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { type MandateDraft, requestMandate } from "./actions";

const TESTID = "request-mandate";

const PERIODS = ["daily", "weekly", "monthly"] as const;

/**
 * The starter set of consequence tags (MC spec §6.9 part 1). More than one may
 * be named, and usually must be: a mandate covers a tool only when it names
 * every tag that tool declares, so naming one of a tool's two mints a mandate
 * that authorizes nothing. Nothing the app may call answers a tool version's
 * `consequence_tags`, so the operator states the set and the hint says the rule.
 */
const CONSEQUENCE_TAGS = [
  "moves_money",
  "destroys_data",
  "alters_production",
  "communicates_externally",
  "changes_access",
  "changes_entitlement",
] as const;

function Field({
  name,
  label,
  hint,
  children,
}: {
  name: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm text-foreground">
      <label htmlFor={`${TESTID}-${name}`}>{label}</label>
      {children}
      {hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

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

function period(form: FormData): MandateDraft["period"] {
  const raw = text(form, "period");
  return PERIODS.find((p) => p === raw) ?? "monthly";
}

export function RequestMandate({
  org,
  ws,
  agentId,
  agentSlug,
}: {
  org: string;
  ws: string;
  agentId: string;
  agentSlug: string;
}) {
  const t = useTranslations("agents.mandates.request");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const result = await requestMandate(org, ws, {
        agentId,
        consequenceTags: chosen(form, "consequenceTags").join(","),
        measure: text(form, "measure"),
        unit: text(form, "unit"),
        perCall: text(form, "perCall"),
        perPeriod: text(form, "perPeriod"),
        period: period(form),
        callsPerDay: text(form, "callsPerDay"),
        tools: text(form, "tools"),
        purpose: text(form, "purpose"),
        validFrom: text(form, "validFrom"),
        validTo: text(form, "validTo"),
      });
      if (result.ok) {
        setOpen(false);
        navigate.replace(routes.agent(org, ws, agentSlug, { tab: "mandates" }));
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const id = (name: string) => `${TESTID}-${name}`;
  return (
    <>
      <button
        type="button"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={t("title")}
        testId={TESTID}
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          <fieldset className="flex flex-col gap-1 text-sm text-foreground">
            <legend>{t("consequenceTags")}</legend>
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
                  />
                  {tag}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("consequenceTagsHint")}
            </p>
          </fieldset>
          <Field name="measure" label={t("measure")} hint={t("measureHint")}>
            <input
              id={id("measure")}
              name="measure"
              required
              maxLength={64}
              className={inputBase}
            />
          </Field>
          <Field name="unit" label={t("unit")} hint={t("unitHint")}>
            <input
              id={id("unit")}
              name="unit"
              required
              maxLength={32}
              className={inputBase}
            />
          </Field>
          <Field name="perCall" label={t("perCall")} hint={t("perCallHint")}>
            <input
              id={id("perCall")}
              name="perCall"
              inputMode="numeric"
              className={inputBase}
            />
          </Field>
          <Field
            name="perPeriod"
            label={t("perPeriod")}
            hint={t("perPeriodHint")}
          >
            <input
              id={id("perPeriod")}
              name="perPeriod"
              inputMode="numeric"
              className={inputBase}
            />
          </Field>
          <Field name="period" label={t("period")}>
            <select
              id={id("period")}
              name="period"
              defaultValue="monthly"
              className={inputBase}
            >
              {PERIODS.map((value) => (
                <option key={value} value={value}>
                  {t(`periods.${value}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field name="callsPerDay" label={t("callsPerDay")}>
            <input
              id={id("callsPerDay")}
              name="callsPerDay"
              inputMode="numeric"
              className={inputBase}
            />
          </Field>
          <Field name="tools" label={t("tools")} hint={t("toolsHint")}>
            <input
              id={id("tools")}
              name="tools"
              required
              className={inputBase}
            />
          </Field>
          <Field name="purpose" label={t("purpose")} hint={t("purposeHint")}>
            <textarea
              id={id("purpose")}
              name="purpose"
              required
              maxLength={2000}
              rows={2}
              className={inputBase}
            />
          </Field>
          <Field name="validFrom" label={t("validFrom")}>
            <input
              id={id("validFrom")}
              name="validFrom"
              type="date"
              required
              className={inputBase}
            />
          </Field>
          <Field name="validTo" label={t("validTo")} hint={t("validToHint")}>
            <input
              id={id("validTo")}
              name="validTo"
              type="date"
              required
              className={inputBase}
            />
          </Field>
          {failure === null ? null : (
            <FormAlert testId={`${TESTID}-failure`}>{failure}</FormAlert>
          )}
          <SubmitButton
            pending={pending}
            label={t("confirm")}
            pendingLabel={t("pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}
