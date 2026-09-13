// Status pieces shared by the sign-in and onboarding screens: an announced
// alert, a pending-aware submit button, and a centred outcome panel.
import { CircleCheck, LoaderCircle, Lock, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { buttonPrimary, panel } from "./styles";

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
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
  className?: string;
  fullWidth?: boolean;
}) {
  return (
    <button
      type="submit"
      aria-disabled={pending || undefined}
      className={`${buttonPrimary} ${fullWidth ? "w-full" : ""} ${className ?? ""}`}
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

const toneClass: Record<OutcomeTone, string> = {
  ok: "border-success/45 bg-success/10 text-success",
  deny: "border-destructive/45 bg-destructive/10 text-destructive",
  neutral: "border-border bg-muted text-muted-foreground",
};

/** A centred result: a glyph, a heading, a body and actions. `role` defaults to status. */
export function OutcomePanel({
  tone,
  title,
  children,
  actions,
  testId,
  icon,
}: {
  tone: OutcomeTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  testId?: string;
  icon?: ReactNode;
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
      aria-labelledby={testId ? `${testId}-title` : undefined}
      data-testid={testId}
      className={`${panel} flex flex-col items-center gap-3 px-6 py-9 text-center`}
    >
      <div
        className={`grid size-11 place-items-center rounded-lg border ${toneClass[tone]}`}
      >
        {glyph}
      </div>
      <h2
        id={testId ? `${testId}-title` : undefined}
        className="text-lg font-semibold text-foreground"
      >
        {title}
      </h2>
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
