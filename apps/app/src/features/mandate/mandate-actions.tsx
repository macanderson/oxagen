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
import { isChangeable } from "@/data/contracts/mandates";
import { decimalFromMicros } from "@/data/contracts/money";
import type { SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, inputBase } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { changeMandateLimits, revokeMandate } from "./actions";

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
 * A counted measure is preferred, so a mandate that holds both opens on the one
 * whose figure is typed as it is stored. A mandate with no counted measure opens
 * on its money limit instead: the currency in the unit field and each figure as
 * a decimal of it ("12.5", never "12500000"). The dialog carries no kind. The
 * action reads the stored kind before it scales a money figure to micros
 * (actions.ts, ADR-108), so a figure typed here is never trusted as money on the
 * strength of what the browser sent.
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
  /** A count's own digits, or the empty string. */
  const countOf = (value: MeasureValue | null | undefined): string =>
    value?.kind === "count" ? value.count : "";
  /** A figure as the field shows it: a count's digits, or money as a plain decimal. */
  const figureOf = (value: MeasureValue | null | undefined): string =>
    value?.kind === "money"
      ? (decimalFromMicros(value.money.micros) ?? "")
      : countOf(value);
  const unitOf = (value: MeasureValue | null | undefined): string =>
    value?.kind === "count"
      ? value.unit
      : value?.kind === "money"
        ? value.money.currency
        : "";
  const isCount = (value: MeasureValue | null | undefined): boolean =>
    value?.kind === "count";
  const isMoney = (value: MeasureValue | null | undefined): boolean =>
    value?.kind === "money";
  // Either bound is enough to prefill from. `mandateLimitSchema` requires only
  // that a limit names `perCall`, `perPeriod` or both, so a bound that caps a
  // single call and leaves the period open is valid and common; matching on
  // `perPeriod` alone opened this dialog blank on one, and the operator had to
  // retype the measure and the unit before they could lower a cap that was
  // already recorded.
  const counted = mandate.authority.find(
    (entry) =>
      entry.measure !== "calls" &&
      (isCount(entry.perPeriod) || isCount(entry.perCall)),
  );
  const limited =
    counted ??
    mandate.authority.find(
      (entry) =>
        entry.measure !== "calls" &&
        (isMoney(entry.perPeriod) || isMoney(entry.perCall)),
    );
  // The unit belongs to whichever bound carries it, so a per-call-only limit
  // still names its own unit rather than falling back to blank.
  const limitedUnit =
    limited?.perPeriod == null ? limited?.perCall : limited.perPeriod;
  const calls = mandate.authority.find((entry) => entry.measure === "calls");
  return {
    measure: limited?.measure ?? "",
    unit: unitOf(limitedUnit),
    period: PERIODS.find((p) => p === limited?.period) ?? "monthly",
    perCall: figureOf(limited?.perCall),
    perPeriod: figureOf(limited?.perPeriod),
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
          <Field
            id={id("measure")}
            label={t("measure")}
            hint={t("measureHint")}
          >
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
              inputMode="decimal"
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
              inputMode="decimal"
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
  const d = useTranslations("mandate.actions.revoke.draft");
  // A draft was never in effect, so nothing in the revoke copy is true of it: no
  // reservation was ever held against it and the ledger has no movement to keep.
  // Declining a request is its own act and the dialog says so. The two
  // namespaces are read separately rather than through one chosen translator,
  // because each `t` is typed to the keys of its own namespace.
  const isDraft = mandate.status === "draft";
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
        {isDraft ? d("open") : t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setFailure(null);
        }}
        title={
          isDraft
            ? d("title", { mandate: mandate.id })
            : t("title", { mandate: mandate.id })
        }
        testId="revoke-mandate"
      >
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {isDraft ? d("body") : t("body")}
          </p>
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
            label={isDraft ? d("confirm") : t("confirm")}
            pendingLabel={isDraft ? d("pending") : t("pending")}
          />
        </form>
      </SheetDialog>
    </>
  );
}

/**
 * The header's actions, each offered only where its handler will accept it.
 *
 * `update_mandate_limits` takes an `active` mandate alone. `revoke_mandate`
 * takes `active` or `draft`, because declining a request is a revocation of a
 * mandate that never took effect, and this page is the only place in the app
 * that calls it: an earlier comment here said a request was declined from the
 * agent's own page, and no such control exists there. A draft with no decline
 * control is a capability the API has and the app does not, which is the one
 * gap this repo treats as seriously as a missing route.
 *
 * Change limits while `update_mandate_limits` would still accept a change
 * (`isChangeable`), which mirrors that handler's own two conditions: active
 * status, and an exclusive `validTo` that has not elapsed. A row still reading
 * `active` past `validTo`, before the expiry job flips it, must not expose a
 * control that could push validTo forward and reopen ended authority.
 *
 * It is deliberately not `isEffective`, which this used and which also requires
 * `validFrom` to have passed. That hid the control on a granted mandate whose
 * window has not opened yet, and this component is the app's only limit-change
 * control, so a scheduled bound could not be corrected here at all. The handler
 * accepts that state, so being stricter than it did not protect anything: it
 * left revoke-and-re-grant as the only way to change a number before the
 * window opens. Upcoming is the case an operator most needs to edit.
 *
 * Revoke stays available so an operator can end a draft request or mark a
 * lapsed row revoked before the cron does. A revoked or expired status offers
 * neither.
 *
 * **`now` is a prop, not a local clock read.** This component is `"use
 * client"`, and a client component still server-renders once in the App
 * Router; a `new Date()` in its own body (or in a `useState` initializer,
 * which only fixes re-renders, not the server/client split) runs once on the
 * server and again on the client during hydration, and those two instants can
 * disagree across `mandate`'s validity boundary — one render shows
 * `ChangeLimits`, the other does not, a hydration mismatch on the control
 * that grants or withholds a limit-changing affordance. `readAt` is resolved
 * once, server-side, in `Mandate` (`mandate.tsx`, the same pattern
 * `readFleet` in `features/fleet/fleet.tsx` uses), and travels down as a prop
 * so both renders agree by construction.
 */
export function MandateActions(place: Place & { now: Date }) {
  const { mandate, now } = place;
  if (mandate.status !== "active" && mandate.status !== "draft") return null;
  return (
    <>
      {isChangeable(mandate, now) ? <ChangeLimits {...place} /> : null}
      <Revoke {...place} />
    </>
  );
}
