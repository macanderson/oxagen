// The onboarding gate's own shell (mockup `regShell` in onboard mode): the
// brandmark, the signed-in email and Cancel on the top bar, the three-step rail
// labelled "Onboarding", the step's body, and the gate's caption. There is no
// sidebar and no topbar, so no approvals button or drawer: the operator console
// does not exist for this organization until its first frame arrives.
//
// The rail is positional, as the design draws it: the steps before this one are
// done and open their page, this one is current, the ones after it cannot be
// opened yet. Each target is a SafePath (INV-13); a step with no target is a
// disabled button, so it is announced as unavailable rather than hidden.
import { OxagenWordmark } from "@oxagen/ui";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";

const GATE_STEPS = ["organization", "wrap", "run"] as const;
export type GateStepId = (typeof GATE_STEPS)[number];

const railItem =
  "flex min-h-11 min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-[13px] max-sm:justify-center sm:px-3.5";

function Mark({ n, state }: { n: number; state: "done" | "current" | "todo" }) {
  const tone =
    state === "done"
      ? "border-success text-success"
      : state === "current"
        ? "border-accent-text text-accent-text"
        : "border-muted-foreground text-muted-foreground";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex size-[22px] flex-none items-center justify-center rounded-full border text-[11px] ${tone}`}
    >
      {state === "done" ? "✓" : n}
    </span>
  );
}

function GateRail({
  step,
  back,
}: {
  step: GateStepId;
  back: Partial<Record<GateStepId, SafePath>>;
}) {
  const t = useTranslations("onboarding.welcome.shell");
  const current = GATE_STEPS.indexOf(step);
  return (
    <nav aria-label={t("railLabel")} data-testid="gate-rail">
      <ol className="flex overflow-hidden rounded-xl border border-border bg-card">
        {GATE_STEPS.map((id, index) => {
          const state =
            index < current ? "done" : index === current ? "current" : "todo";
          const label = (
            <>
              <Mark n={index + 1} state={state} />
              <span className="truncate max-sm:sr-only">
                {t(`steps.${id}`)}
              </span>
              <span className="sr-only">{t(`state.${state}`)}</span>
            </>
          );
          const to = back[id];
          return (
            <li
              key={id}
              data-step={id}
              data-state={state}
              className={`flex min-w-0 flex-1 border-border not-last:border-r ${state === "current" ? "bg-hl" : ""}`}
            >
              {state === "current" ? (
                <span
                  aria-current="step"
                  className={`${railItem} font-medium text-foreground`}
                >
                  {label}
                </span>
              ) : state === "done" && to !== undefined ? (
                <SafeLink
                  to={to}
                  className={`${railItem} text-success hover:bg-hl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`}
                >
                  {label}
                </SafeLink>
              ) : (
                <button
                  type="button"
                  disabled
                  className={`${railItem} text-muted-foreground disabled:cursor-not-allowed`}
                >
                  {label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The gate's frame. `back` names where each done step opens; a done step with
 * no target renders as a disabled button. `cancel` is where Cancel goes.
 *
 * `pending` marks a Suspense fallback. Its body is a busy region, not the
 * page's `main`. While a step streams in, the document holds the fallback and
 * the hidden step together, and only the step may own `main#main`: two would
 * give the skip link two targets and fail the page-load oracle's strict
 * locator, as they did on 2026-09-24.
 */
export function GateShell({
  step,
  email,
  cancel,
  back = {},
  pending = false,
  children,
}: {
  step: GateStepId;
  /** The signed-in person's email, or null when the session carries none. */
  email: string | null;
  cancel: SafePath;
  back?: Partial<Record<GateStepId, SafePath>>;
  pending?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("onboarding.welcome.shell");
  const body = (
    <>
      <GateRail step={step} back={back} />
      {children}
      <p className="mt-1 text-center text-xs leading-relaxed text-muted-foreground">
        {t("caption")}
      </p>
    </>
  );
  const bodyClass = "flex min-w-0 flex-col gap-5 pt-7";
  return (
    <div className="min-h-dvh bg-background px-4 pb-14 sm:px-5">
      <div className="mx-auto flex w-full max-w-[772px] flex-col">
        <header className="flex items-center gap-3 pt-[18px]">
          <OxagenWordmark className="h-6" />
          <div className="ml-auto flex min-w-0 items-center gap-3">
            {email === null ? null : (
              <span
                data-testid="gate-email"
                className="truncate font-mono text-[11.5px] text-muted-foreground max-sm:hidden"
              >
                {email}
              </span>
            )}
            <SafeLink
              to={cancel}
              data-testid="gate-cancel"
              className={`${buttonSecondary} text-xs`}
            >
              {t("cancel")}
            </SafeLink>
          </div>
        </header>
        {pending ? (
          <div aria-busy="true" className={bodyClass}>
            {body}
          </div>
        ) : (
          <main id="main" className={bodyClass}>
            {body}
          </main>
        )}
      </div>
    </div>
  );
}

/** The step's header: eyebrow, h1 and lead (mockup `.eyebrow`, `h1`, `.reg-lead`). */
export function GateHeader({
  eyebrow,
  title,
  lead,
}: {
  eyebrow?: string;
  title: string;
  lead: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 pt-2">
      {eyebrow === undefined ? null : (
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-accent-text">
          {eyebrow}
        </p>
      )}
      <h1 className="text-[23px] font-bold tracking-tight text-foreground">
        {title}
      </h1>
      <p className="max-w-[560px] text-sm leading-relaxed text-muted-foreground">
        {lead}
      </p>
    </div>
  );
}

/**
 * The card footer (mockup `.reg-foot`): the left actions, then the caption and
 * the last action pushed to the far side. On a phone every action is full
 * width and 44px tall (buttonBase carries the height).
 */
export function GateFooter({
  start,
  caption,
  end,
}: {
  start: ReactNode;
  caption?: ReactNode;
  end?: ReactNode;
}) {
  return (
    <div
      data-testid="gate-footer"
      className="flex flex-wrap items-center gap-2.5 max-md:flex-col max-md:items-stretch max-md:[&_a]:w-full max-md:[&_button]:w-full"
    >
      {start}
      <div className="flex flex-wrap items-center gap-2.5 md:ml-auto max-md:flex-col max-md:items-stretch">
        {caption === undefined ? null : (
          <span className="text-xs text-muted-foreground max-md:text-center">
            {caption}
          </span>
        )}
        {end}
      </div>
    </div>
  );
}
