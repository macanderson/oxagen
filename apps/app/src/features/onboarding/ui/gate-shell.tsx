// The full-screen frame both three-step flows run in (mockup `regShell` @
// mc-baseline-w1): the brand and who is signed in, the stepper, the step, and
// the caption that explains why there is no Done button.
import Link from "next/link";

import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Brandmark } from "@/ui/auth-shell";
import { buttonSecondary } from "@/ui/control-styles";
import { type AgentChoice, flowHref } from "../flow-links";
import { GATE_STEPS, REGISTER_STEPS, type FlowMode } from "../steps";

export type GateShellProps = {
  mode: FlowMode;
  step: string;
  email: string | null;
  /** Where Cancel goes; the gate has no cancel (the app does not open until a frame arrives). */
  cancelHref?: string;
  links: { org: string; ws: string; choice: AgentChoice | null } | null;
  /**
   * Set when the step's content carries no visible <h1> (a denied state, a
   * missing scope): the shell then names the page with the current step's label
   * for assistive technology.
   */
  hiddenTitle?: boolean;
  children: ReactNode;
};

// The gate owns the whole page: its own top bar with the brand and who is signed
// in. Register an agent renders inside the organization shell (lane L3), whose
// top bar already carries the brand and the account, so it drops the header (a
// second banner landmark) and puts Cancel beside the stepper. Both render the
// page's <main id="main">, which the shell's skip link targets.

export async function GateShell({
  mode,
  step,
  email,
  cancelHref,
  links,
  hiddenTitle = false,
  children,
}: GateShellProps) {
  const t = await getTranslations("onboarding");
  const steps: readonly string[] =
    mode === "gate" ? GATE_STEPS : REGISTER_STEPS;
  const current = Math.max(0, steps.indexOf(step));
  return (
    <div
      className={`relative isolate flex flex-col items-center bg-background px-4 pb-16 sm:px-5 ${mode === "gate" ? "min-h-dvh" : ""}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(900px_460px_at_50%_-10%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent_72%)]"
      />
      {mode === "gate" ? (
        <header className="flex w-full max-w-3xl items-center gap-3 pt-5">
          <Brandmark />
          {email ? (
            <span className="ml-auto hidden min-w-0 truncate font-mono text-xs text-muted-foreground sm:block">
              {t("shell.signedInAs", { email })}
            </span>
          ) : null}
        </header>
      ) : null}
      <main id="main" className="flex w-full max-w-3xl min-w-0 flex-col">
        {hiddenTitle ? (
          <h1 className="sr-only">
            {t(`steps.${mode}.${steps[current] ?? step}`)}
          </h1>
        ) : null}
        {cancelHref ? (
          <div className="flex justify-end pt-5">
            <Link
              href={cancelHref}
              className={`${buttonSecondary} min-h-8 px-3 py-1 text-xs`}
            >
              {t("shell.cancel")}
            </Link>
          </div>
        ) : null}
        <nav
          aria-label={
            mode === "gate" ? t("shell.gateLabel") : t("shell.registerLabel")
          }
          className="mt-7 mb-6"
        >
          <ol className="flex overflow-hidden rounded-xl border border-border bg-card">
            {steps.map((s, i) => {
              const label = t(`steps.${mode}.${s}`);
              const done = i < current;
              const isCurrent = i === current;
              const marker = (
                <span
                  aria-hidden
                  className={`grid size-5.5 flex-none place-items-center rounded-full border font-mono text-[11px] ${isCurrent ? "border-primary text-foreground" : done ? "border-success" : "border-current"}`}
                >
                  {done ? "✓" : i + 1}
                </span>
              );
              const body = (
                <>
                  {marker}
                  <span className="hidden truncate sm:inline">{label}</span>
                  <span className="sr-only sm:hidden">{label}</span>
                </>
              );
              const cell =
                "flex min-w-0 flex-1 items-center gap-2.5 px-3.5 py-3 text-sm";
              return (
                <li
                  key={s}
                  className="flex min-w-0 flex-1 border-r border-border last:border-r-0"
                >
                  {done && links ? (
                    <Link
                      href={flowHref(mode, s, links)}
                      className={`${cell} text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`}
                      aria-label={t("shell.done", { label })}
                    >
                      {body}
                    </Link>
                  ) : (
                    <span
                      className={`${cell} ${isCurrent ? "bg-accent text-foreground" : "text-muted-foreground"}`}
                      aria-current={isCurrent ? "step" : undefined}
                    >
                      {body}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        {children}
        <p className="mx-auto mt-6 max-w-prose text-center text-xs text-muted-foreground">
          {mode === "gate"
            ? t("shell.gateCaption")
            : t("shell.registerCaption")}
        </p>
      </main>
    </div>
  );
}

export function StepHeading({
  index,
  total,
  title,
  lead,
}: {
  index: number;
  total: number;
  title: string;
  lead: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <StepOf index={index} total={total} />
      <h1 className="text-2xl leading-tight font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      <p className="max-w-[64ch] text-sm leading-relaxed text-muted-foreground">
        {lead}
      </p>
    </div>
  );
}

async function StepOf({ index, total }: { index: number; total: number }) {
  const t = await getTranslations("onboarding.shell");
  return (
    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
      {t("stepOf", { current: index + 1, total })}
    </p>
  );
}

export async function GateSkeleton() {
  const t = await getTranslations("onboarding.shell");
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center bg-background px-4 pt-24"
      data-testid="page-state-loading"
    >
      <h1 className="sr-only">{t("loading")}</h1>
      <div
        role="status"
        aria-live="polite"
        className="flex w-full max-w-3xl flex-col gap-4"
      >
        <span className="sr-only">{t("loading")}</span>
        <div className="h-12 w-full animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        <div className="h-8 w-2/3 animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
        <div className="h-64 w-full animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
      </div>
    </main>
  );
}
