// Form status pieces: an announced alert, a pending-aware submit button, and a
// centred outcome panel. Words stay in the text ink; red is carried by the
// glyph and the border, so every tone passes AA on the panel.
import { CircleCheck, LoaderCircle, Lock, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { buttonPrimary, buttonSecondary, panel } from "./control-styles";
import { FocusedHeading } from "./focused-heading";

export function FormAlert({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-foreground"
    >
      <TriangleAlert
        aria-hidden
        className="mt-0.5 size-4 flex-none text-destructive"
      />
      <span>{children}</span>
    </div>
  );
}

export function SubmitButton({
  pending,
  label,
  pendingLabel,
  className,
  fullWidth = true,
  form,
  testId,
  secondary = false,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  className?: string;
  fullWidth?: boolean;
  /** The id of the form it submits when it is rendered outside that form (a dialog footer). */
  form?: string;
  testId?: string;
  /**
   * Draw it as a secondary button. A screen has one gold action, so a submit
   * that sits beside the screen's primary action gives up the gold.
   */
  secondary?: boolean;
}) {
  return (
    <button
      type="submit"
      form={form}
      data-testid={testId}
      // Every submit is a control, so at phone width it is a 44px target
      // whether it sits in its form or in a dialog footer (phone.css).
      data-touch-target=""
      aria-disabled={pending || undefined}
      className={`${secondary ? buttonSecondary : buttonPrimary} ${fullWidth ? "w-full" : ""} ${className ?? ""}`}
    >
      {pending ? (
        <>
          <LoaderCircle
            aria-hidden
            className="size-4 animate-spin motion-reduce:animate-none"
          />
          <span>{pendingLabel}</span>
        </>
      ) : (
        label
      )}
    </button>
  );
}

export type OutcomeTone = "ok" | "deny" | "neutral";

const OUTCOME_TITLE = "text-lg font-semibold text-foreground";

const toneClass: Record<OutcomeTone, string> = {
  ok: "border-success/45 bg-success/10 text-success",
  deny: "border-destructive/45 bg-destructive/10 text-destructive",
  neutral: "border-border bg-muted text-muted-foreground",
};

/**
 * A centred result: a glyph, a heading, a body and actions. A panel that
 * replaces a form the person just submitted sets `announce`: it becomes a
 * status region and its heading takes focus, because the submit button that
 * held focus is gone. A panel a page renders on load leaves it off, so opening
 * the page does not move focus.
 */
export function OutcomePanel({
  tone,
  title,
  children,
  actions,
  testId,
  icon,
  announce = false,
}: {
  tone: OutcomeTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  testId?: string;
  icon?: ReactNode;
  announce?: boolean;
}) {
  const glyph =
    icon ??
    (tone === "ok" ? (
      <CircleCheck aria-hidden className="size-5" />
    ) : tone === "deny" ? (
      <Lock aria-hidden className="size-5" />
    ) : (
      <TriangleAlert aria-hidden className="size-5" />
    ));
  return (
    <section
      role={announce ? "status" : undefined}
      aria-labelledby={testId ? `${testId}-title` : undefined}
      data-testid={testId}
      className={`${panel} flex flex-col items-center gap-3 px-6 py-9 text-center`}
    >
      <div
        className={`grid size-11 place-items-center rounded-lg border ${toneClass[tone]}`}
      >
        {glyph}
      </div>
      {announce ? (
        <FocusedHeading
          id={testId ? `${testId}-title` : undefined}
          className={OUTCOME_TITLE}
        >
          {title}
        </FocusedHeading>
      ) : (
        <h2
          id={testId ? `${testId}-title` : undefined}
          className={OUTCOME_TITLE}
        >
          {title}
        </h2>
      )}
      {children ? (
        <div className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {children}
        </div>
      ) : null}
      {actions ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {actions}
        </div>
      ) : null}
    </section>
  );
}
