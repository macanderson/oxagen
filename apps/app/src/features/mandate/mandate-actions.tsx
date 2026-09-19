"use client";
// The two writes in the mandate header, each behind a dialog that says what it
// will do before it does it: change the limits, and revoke.
//
// **One gold action on the screen.** Change limits carries the primary
// (identity) style and Revoke carries the ordinary one. Gold marks the action a
// reader is meant to take, never a state and never a severity, so the ending of
// a mandate does not get the loudest control on the page; its dialog says what
// it ends, and the confirm sits behind a reason the operator has to write.
//
// Neither control is hidden from a reader whose roles cannot make the write.
// Hiding a button is not a gate — the handlers hold the gate (see actions.ts) —
// and a reader told "your roles are not accountable for this mandate's
// consequences" has learned something, where a reader shown nothing has only
// been left to guess.
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import type { MandateRow, MeasureValue } from "@/data/contracts/mandates";
import type { SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { changeMandateLimits, revokeMandate } from "./actions";
import { offsetAfter } from "./validity";

const PERIODS = ["daily", "weekly", "monthly"] as const;

type Place = { org: string; ws: string; mandate: MandateRow; here: SafePath };

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function period(form: FormData, name: string): (typeof PERIODS)[number] {
  const raw = text(form, name);
  return PERIODS.find((p) => p === raw) ?? "monthly";
}


function Field({
  id,
  label,
  hint,
  children,
}: {
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

/**
 * The measure entry the dialog opens with, taken from the mandate's own
 * authority: the first limited measure that is not the built-in `calls`, so an
 * operator changing one figure does not have to retype it. The other measures
 * need no defaults, because the handler keeps every bound a submission does not
 * name (ADR-102).
 *
 * **Every value this returns is rendered twice: into the field the operator
 * edits, and into a hidden field beside it.** The hidden one is the baseline
 * `changeMandateLimits` compares against, so a prefill the operator never touched
 * is left out of the change instead of asserted as an edit over a record another
 * operator may have narrowed since. Both come from this one call in one render
 * and both are seeded through `defaultValue`, so the pair is set together or not
 * at all: the baseline cannot drift from the visible default, and a later render
 * with a fresher mandate moves neither. Reopening the dialog unmounts the form
 * and reads both again.
 *
 * A money measure has no default figure here on purpose. `update_mandate_limits`
 * stores what it is given, and whether a figure is micros or whole units is a
 * property of the tool version's declaration that no read answers, so a money
 * limit is changed over the API or MCP rather than round-tripped through a form
 * that cannot scale it. The unit field refuses a currency code for the same
 * reason.
 */
function measureDefaults(mandate: MandateRow): {
  measure: string;
  unit: string;
  period: (typeof PERIODS)[number];
  perCall: string;
  perPeriod: string;
  callsPerDay: string;
  /**
   * The window the stored calls cap is counted in, which the form does not let
   * anyone change. It is carried so the field can be LABELLED with it: the label
   * read "Calls per day" against a figure that might be per week, and since the
   * submission now keeps the stored window rather than rewriting it to daily,
   * typing 20 into a field marked "per day" would write twenty calls a week.
   * A label that names the window is honest with one string; a second period
   * control would be a wider change to a form that cannot delete a limit either.
   */
  callsPeriod: (typeof PERIODS)[number];
} {
  /** A count's own digits, or the empty string; a money figure defaults to blank. */
  const countOf = (value: MeasureValue | null | undefined): string =>
    value?.kind === "count" ? value.count : "";
  const unitOf = (value: MeasureValue | null | undefined): string =>
    value?.kind === "count" ? value.unit : "";
  const counted = mandate.authority.find(
    (entry) => entry.measure !== "calls" && entry.perPeriod?.kind === "count",
  );
  const calls = mandate.authority.find((entry) => entry.measure === "calls");
  return {
    measure: counted?.measure ?? "",
    unit: unitOf(counted?.perPeriod),
    period: PERIODS.find((p) => p === counted?.period) ?? "monthly",
    perCall: countOf(counted?.perCall),
    perPeriod: countOf(counted?.perPeriod),
    callsPerDay: countOf(calls?.perPeriod),
    // `daily` when nothing is stored, which is the window a new cap is written
    // under, so the label matches what a submission would create.
    callsPeriod: PERIODS.find((p) => p === calls?.period) ?? "daily",
  };
}

function ChangeLimits({ org, ws, mandate, here }: Place) {
  const t = useTranslations("mandate.actions.limits");
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const defaults = measureDefaults(mandate);
  const id = (name: string) => `change-limits-${name}`;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const result = await changeMandateLimits(org, ws, {
        mandateId: mandate.id,
        measure: text(form, "measure"),
        unit: text(form, "unit"),
        perCall: text(form, "perCall"),
        perPeriod: text(form, "perPeriod"),
        period: period(form, "period"),
        callsPerDay: text(form, "callsPerDay"),
        validTo: text(form, "validTo"),
        validToOffsetMinutes: offsetAfter(text(form, "validTo")),
        // Read from the form rather than from `defaults` in this closure, so what
        // the action compares against is the string that seeded the field the
        // operator saw, not one recomputed from a prop that may have moved on.
        baseline: {
          measure: text(form, "baselineMeasure"),
          unit: text(form, "baselineUnit"),
          perCall: text(form, "baselinePerCall"),
          perPeriod: text(form, "baselinePerPeriod"),
          period: period(form, "baselinePeriod"),
          callsPerDay: text(form, "baselineCallsPerDay"),
        },
      });
      if (result.ok) {
        setOpen(false);
        navigate.replace(here);
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={buttonPrimary}
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
        title={t("title", { mandate: mandate.id })}
        testId="change-limits"
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          <Field id={id("measure")} label={t("measure")} hint={t("measureHint")}>
            <input
              id={id("measure")}
              name="measure"
              defaultValue={defaults.measure}
              className={inputBase}
            />
            {/* What this field opened with. The action carries a field into the
                change only when the operator's value differs from it, so a
                prefill nobody touched cannot restore a bound somebody lowered
                while this dialog was open (actions.ts, ADR-102). */}
            <input
              type="hidden"
              name="baselineMeasure"
              defaultValue={defaults.measure}
            />
          </Field>
          <Field id={id("unit")} label={t("unit")} hint={t("unitHint")}>
            <input
              id={id("unit")}
              name="unit"
              defaultValue={defaults.unit}
              className={inputBase}
            />
            <input
              type="hidden"
              name="baselineUnit"
              defaultValue={defaults.unit}
            />
          </Field>
          <Field id={id("perCall")} label={t("perCall")}>
            <input
              id={id("perCall")}
              name="perCall"
              inputMode="numeric"
              defaultValue={defaults.perCall}
              className={inputBase}
            />
            <input
              type="hidden"
              name="baselinePerCall"
              defaultValue={defaults.perCall}
            />
          </Field>
          <Field id={id("perPeriod")} label={t("perPeriod")}>
            <input
              id={id("perPeriod")}
              name="perPeriod"
              inputMode="numeric"
              defaultValue={defaults.perPeriod}
              className={inputBase}
            />
            <input
              type="hidden"
              name="baselinePerPeriod"
              defaultValue={defaults.perPeriod}
            />
          </Field>
          <Field id={id("period")} label={t("period")}>
            <select
              id={id("period")}
              name="period"
              defaultValue={defaults.period}
              className={inputBase}
            >
              {PERIODS.map((value) => (
                <option key={value} value={value}>
                  {t(`periods.${value}`)}
                </option>
              ))}
            </select>
            <input
              type="hidden"
              name="baselinePeriod"
              defaultValue={defaults.period}
            />
          </Field>
          <Field
            id={id("callsPerDay")}
            label={t("callsPer", {
              period: t(`periodsPer.${defaults.callsPeriod}`),
            })}
          >
            <input
              id={id("callsPerDay")}
              name="callsPerDay"
              inputMode="numeric"
              defaultValue={defaults.callsPerDay}
              className={inputBase}
            />
            <input
              type="hidden"
              name="baselineCallsPerDay"
              defaultValue={defaults.callsPerDay}
            />
          </Field>
          <Field
            id={id("validTo")}
            label={t("validTo")}
            hint={t("validToHint")}
          >
            <input
              id={id("validTo")}
              name="validTo"
              type="date"
              className={inputBase}
            />
          </Field>
          {failure === null ? null : (
            <FormAlert testId="change-limits-failure">{failure}</FormAlert>
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

function Revoke({ org, ws, mandate, here }: Place) {
  const t = useTranslations("mandate.actions.revoke");
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
      const result = await revokeMandate(org, ws, {
        mandateId: mandate.id,
        reason: text(form, "reason"),
      });
      if (result.ok) {
        setOpen(false);
        navigate.replace(here);
      } else {
        setFailure(failureText(result));
      }
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

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
        title={t("title", { mandate: mandate.id })}
        testId="revoke-mandate"
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("body")}</p>
          <Field
            id="revoke-mandate-reason"
            label={t("reason")}
            hint={t("reasonHint")}
          >
            <textarea
              id="revoke-mandate-reason"
              name="reason"
              required
              rows={2}
              maxLength={2000}
              className={inputBase}
            />
          </Field>
          {failure === null ? null : (
            <FormAlert testId="revoke-mandate-failure">{failure}</FormAlert>
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

/**
 * The header's actions. A mandate that has already ended offers neither: both
 * handlers refuse a status other than `active` (revoke also takes a `draft`,
 * which is how a request is declined, and the request is declined from the
 * agent's own page), so offering them here would be offering a control the
 * kernel is certain to refuse.
 */
export function MandateActions(place: Place) {
  if (place.mandate.status !== "active") return null;
  return (
    <>
      <ChangeLimits {...place} />
      <Revoke {...place} />
    </>
  );
}
