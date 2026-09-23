"use client";
// The two writes in the mandate header, each behind the dialog the design
// names: Change limits opens `mandateedit`, Revoke opens `mandaterevoke`. Both
// carry the id of the mandate the route names, so neither can act on another.
//
// **No gold on the page.** The design gives the page body no gold action:
// Change limits is an ordinary button and Revoke a danger one. Save is the
// edit dialog's gold; Revoke it is drawn as a danger button, as the design
// draws it, because an irreversible write is not the screen's identity.
//
// **A write that lands says so.** The dialog closes, the page reads the record
// again, and a line under the actions names the mandate, what it now is, and
// where the change is recorded (the Audit page, filtered to the capability).
// The line lives in `MandateActions`, which stays mounted across the refresh,
// so it survives a revoke that removes the buttons it came from.
//
// Neither control is hidden from a reader whose roles cannot make the write.
// Hiding a button is not a gate. The handlers hold the gate (actions.ts), and a
// reader told why the write was refused has learned something.
import { LoaderCircle } from "lucide-react";
import { useTimeZone, useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useId, useState } from "react";
import { isChangeable, type MandateRow } from "@/data/contracts/mandates";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonDanger,
  buttonSecondary,
  inputBase,
  linkText,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { useMeasureText } from "@/ui/measure";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { UNANSWERED, useActionFailure } from "./action-failure";
import { changeMandateLimits, revokeMandate } from "./actions";
import { editableOf, lastDayOf, measuresOf, thresholdOf, unitOf } from "./view";

/** What a write that landed did, for the line under the actions. */
type Outcome = {
  kind: "limits" | "revoked" | "declined";
  mandate: string;
  capability: "update_mandate_limits" | "revoke_mandate";
};

type Place = {
  org: string;
  ws: string;
  mandate: MandateRow;
  here: SafePath;
  /** The agent's key (`org.ws.slug`), which the dialogs name; null when the agent read did not answer. */
  agentKey: string | null;
  done: (outcome: Outcome) => void;
};

// 16px on a phone, as the design's inputs are, so iOS does not zoom the sheet.
const field = `${inputBase} max-md:min-h-11 max-md:text-base`;

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
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
      <label htmlFor={id} className="text-xs font-semibold">
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** The design's `.note`: a gold rule on the left, muted copy. */
function Note({ children }: { children: ReactNode }) {
  return (
    <p className="border-l-2 border-gold py-0.5 pl-3 text-[12.5px] text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * `mandateedit`: per call, per period, approval above and valid to, for the
 * measure the tiles speak for, in that measure's own unit.
 *
 * **Every field renders twice: the one the operator edits, and a hidden
 * baseline beside it seeded from the same value in the same render.** The
 * action carries a field into the change only when the two differ, so a prefill
 * nobody touched cannot restore a bound another operator lowered while this
 * dialog was open (ADR-102). A field left blank keeps what is stored: removing a
 * limit is a whole-record write over the API.
 */
function ChangeLimits({ org, ws, mandate, here, agentKey, done }: Place) {
  const t = useTranslations("mandate.actions.limits");
  const timeZone = useTimeZone();
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { primary } = measuresOf(mandate);
  if (primary === null) return null;
  const unit = unitOf(primary);
  const threshold = thresholdOf(mandate, primary.measure);
  const defaults = {
    perCall: editableOf(primary.perCall),
    perPeriod: editableOf(primary.perPeriod),
    approvalAbove: threshold === null ? "" : editableOf(threshold.value),
    // The last day the mandate may be drawn on, in the zone this app draws
    // dates in. Blank when the zone is unknown: a guessed zone would prefill
    // a day the window does not end on.
    validTo:
      timeZone === undefined
        ? ""
        : (lastDayOf(mandate.validTo, timeZone) ?? ""),
  };
  const id = (name: string) => `${formId}-${name}`;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || primary === null) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailure(null);
    try {
      const result = await changeMandateLimits(org, ws, {
        mandateId: mandate.id,
        measure: primary.measure,
        perCall: text(form, "perCall"),
        perPeriod: text(form, "perPeriod"),
        approvalAbove: text(form, "approvalAbove"),
        validTo: text(form, "validTo"),
        baseline: {
          perCall: text(form, "baselinePerCall"),
          perPeriod: text(form, "baselinePerPeriod"),
          approvalAbove: text(form, "baselineApprovalAbove"),
          validTo: text(form, "baselineValidTo"),
        },
      });
      if (result.ok) {
        setOpen(false);
        done({
          kind: "limits",
          mandate: result.value.mandateId,
          capability: "update_mandate_limits",
        });
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
        subtitle={agentKey ?? mandate.agentSlug}
        closeLabel={t("cancel")}
        headerClose
        testId="change-limits"
        footer={
          <SubmitButton
            form={formId}
            fullWidth={false}
            pending={pending}
            label={t("confirm")}
            pendingLabel={t("pending")}
          />
        }
      >
        <form
          id={formId}
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={id("perCall")} label={t("perCall", { unit })}>
              <input
                id={id("perCall")}
                name="perCall"
                inputMode="decimal"
                defaultValue={defaults.perCall}
                className={field}
              />
              <input
                type="hidden"
                name="baselinePerCall"
                defaultValue={defaults.perCall}
              />
            </Field>
            <Field
              id={id("perPeriod")}
              label={t("perPeriod", {
                window: t(`windows.${primary.period}`),
                unit,
              })}
            >
              <input
                id={id("perPeriod")}
                name="perPeriod"
                inputMode="decimal"
                defaultValue={defaults.perPeriod}
                className={field}
              />
              <input
                type="hidden"
                name="baselinePerPeriod"
                defaultValue={defaults.perPeriod}
              />
            </Field>
          </div>
          <Field
            id={id("approvalAbove")}
            label={t("approvalAbove", { unit })}
            hint={t("approvalHint")}
          >
            <input
              id={id("approvalAbove")}
              name="approvalAbove"
              inputMode="decimal"
              defaultValue={defaults.approvalAbove}
              className={field}
            />
            <input
              type="hidden"
              name="baselineApprovalAbove"
              defaultValue={defaults.approvalAbove}
            />
          </Field>
          <Field id={id("validTo")} label={t("validTo")}>
            <input
              id={id("validTo")}
              name="validTo"
              type="date"
              defaultValue={defaults.validTo}
              className={field}
            />
            <input
              type="hidden"
              name="baselineValidTo"
              defaultValue={defaults.validTo}
            />
          </Field>
          <Note>{t("note")}</Note>
          {failure === null ? null : (
            <FormAlert testId="change-limits-failure">{failure}</FormAlert>
          )}
        </form>
      </SheetDialog>
    </>
  );
}

/**
 * `mandaterevoke`: says what is reserved and what already settled, keeps the
 * ledger, and asks for the reason `revoke_mandate` requires. A draft was never
 * in effect, so its dialog declines a request instead and claims nothing about
 * money.
 */
function Revoke({ org, ws, mandate, here, agentKey, done }: Place) {
  const t = useTranslations("mandate.actions.revoke");
  const d = useTranslations("mandate.actions.revoke.draft");
  const measureText = useMeasureText();
  const isDraft = mandate.status === "draft";
  const failureText = useActionFailure();
  const navigate = useNavigate();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { primary } = measuresOf(mandate);

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
        done({
          kind: isDraft ? "declined" : "revoked",
          mandate: result.value.mandateId,
          capability: "revoke_mandate",
        });
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

  const confirm = isDraft ? d("confirm") : t("confirm");
  return (
    <>
      <button
        type="button"
        className={buttonDanger}
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
        closeLabel={t("cancel")}
        headerClose
        testId="revoke-mandate"
        footer={
          // The design draws the confirmation as a danger button, not gold:
          // it ends the agent's authority, and gold is identity, never a
          // warning (SubmitButton draws only gold or secondary).
          <button
            type="submit"
            form={formId}
            data-touch-target=""
            aria-disabled={pending || undefined}
            className={buttonDanger}
          >
            {pending ? (
              <>
                <LoaderCircle
                  aria-hidden
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
                <span>{isDraft ? d("pending") : t("pending")}</span>
              </>
            ) : (
              confirm
            )}
          </button>
        }
      >
        <form
          id={formId}
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-3"
        >
          {isDraft ? (
            <p className="text-sm text-muted-foreground">{d("body")}</p>
          ) : (
            <>
              <div
                data-testid="revoke-warning"
                className="rounded-[10px] border border-critical/45 bg-critical/10 px-3.5 py-2.5 text-[12.5px] text-foreground"
              >
                <b className="text-critical">
                  {t("warnTitle", { agent: agentKey ?? mandate.agentSlug })}
                </b>{" "}
                {primary === null
                  ? t("warnNoMeasure")
                  : t("warnBody", {
                      reserved: measureText(primary.reserved),
                      settled: measureText(primary.settled),
                    })}
              </div>
              <Note>{t("note")}</Note>
            </>
          )}
          <Field
            id={`${formId}-reason`}
            label={t("reason")}
            hint={t("reasonHint")}
          >
            <textarea
              id={`${formId}-reason`}
              name="reason"
              required
              rows={2}
              maxLength={2000}
              className={field}
            />
          </Field>
          {failure === null ? null : (
            <FormAlert testId="revoke-mandate-failure">{failure}</FormAlert>
          )}
        </form>
      </SheetDialog>
    </>
  );
}

/** The line a landed write leaves: the mandate, what it now is, and where the change is recorded. */
function OutcomeLine({ org, outcome }: { org: string; outcome: Outcome }) {
  const t = useTranslations("mandate.actions.outcome");
  return (
    <p
      role="status"
      data-testid="mandate-outcome"
      className="text-xs text-muted-foreground sm:text-right"
    >
      {t.rich(outcome.kind, {
        mandate: outcome.mandate,
        id: (chunks) => <span className={mono}>{chunks}</span>,
      })}{" "}
      <SafeLink
        to={routes.audit(org, { capability: outcome.capability })}
        className={linkText}
      >
        {t("audit")}
      </SafeLink>
    </p>
  );
}

/**
 * The header's actions, each offered only where its handler will accept it.
 *
 * `update_mandate_limits` takes an active mandate whose exclusive `validTo`
 * has not elapsed (`isChangeable`, which mirrors the handler and deliberately
 * not `isEffective`: a granted mandate whose window has not opened is the one
 * an operator most needs to correct). `revoke_mandate` takes `active` or
 * `draft`; declining a request is a revocation of a mandate that never took
 * effect. A revoked or expired mandate offers neither.
 *
 * `now` is the instant the server read the mandate, passed down so the server
 * render and the hydration agree on whether Change limits exists.
 */
export function MandateActions(place: Omit<Place, "done"> & { now: Date }) {
  const t = useTranslations("mandate.actions");
  const { mandate, now } = place;
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const writable = mandate.status === "active" || mandate.status === "draft";
  if (!writable && outcome === null) return null;
  const withDone = { ...place, done: setOutcome };
  return (
    <div className="flex shrink-0 flex-col gap-2 sm:items-end">
      {writable ? (
        <div
          role="group"
          aria-label={t("label")}
          className="flex flex-wrap items-center gap-2"
        >
          {isChangeable(mandate, now) ? <ChangeLimits {...withDone} /> : null}
          <Revoke {...withDone} />
        </div>
      ) : null}
      {outcome === null ? null : (
        <OutcomeLine org={place.org} outcome={outcome} />
      )}
    </div>
  );
}
