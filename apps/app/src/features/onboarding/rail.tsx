// The rails both flows draw: the gate's three steps over the real pages
// (ADR-065 decision 1) and the register stepper's own three. Presentational —
// the caller translates each step and hands its target, which is a SafePath or
// nothing (INV-13). The state is a word as well as a mark, so it survives
// greyscale.
import type { ReactNode } from "react";
import type { StepState } from "./steps";
import type { SafePath } from "@/shared/safe-path";
import { SafeLink } from "@/ui/navigation";

export type RailStep = {
  /** Stable across renders and unique in the rail; used as the React key and the test hook. */
  key: string;
  label: string;
  sub?: string;
  state: StepState;
  /** Where the step opens, or null when the operator cannot open it from here. */
  to: SafePath | null;
  /** The translated word for the state, announced to assistive technology. */
  stateLabel: string;
};

const MARK: Record<StepState, string> = {
  done: "border-success bg-success/15 text-success",
  current: "border-foreground bg-foreground text-background",
  todo: "border-border bg-muted text-muted-foreground",
};

function Body({ step, index }: { step: RailStep; index: number }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`inline-flex size-6 flex-none items-center justify-center rounded-full border text-xs font-semibold ${MARK[step.state]}`}
      >
        {step.state === "done" ? "✓" : index + 1}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-foreground">
          {step.label}
        </span>
        {step.sub === undefined ? null : (
          <span className="text-xs text-muted-foreground">{step.sub}</span>
        )}
      </span>
      <span className="sr-only">{step.stateLabel}</span>
    </>
  );
}

export function Rail({
  label,
  steps,
}: {
  /** The rail's accessible name, already translated. */
  label: string;
  steps: readonly RailStep[];
}) {
  return (
    <nav aria-label={label}>
      <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-4">
        {steps.map((step, index) => {
          const content: ReactNode = <Body step={step} index={index} />;
          return (
            <li
              key={step.key}
              data-testid="rail-step"
              data-step={step.key}
              data-state={step.state}
              className="min-w-0 flex-1"
            >
              {step.to === null ? (
                <span
                  {...(step.state === "current"
                    ? { "aria-current": "step" as const }
                    : {})}
                  className="flex min-h-11 items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2"
                >
                  {content}
                </span>
              ) : (
                <SafeLink
                  to={step.to}
                  {...(step.state === "current"
                    ? { "aria-current": "step" as const }
                    : {})}
                  className="flex min-h-11 items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 hover:border-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {content}
                </SafeLink>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const SEGMENT_MARK: Record<StepState, string> = {
  done: "border-success text-success",
  current: "border-accent-text text-accent-text",
  todo: "border-border text-muted-foreground",
};

const segment =
  "flex min-h-11 w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] max-md:justify-center";

/**
 * The register gate's rail (register-name spec, Shell; mockup `.reg-steps`):
 * three segments in one bordered strip. A done step shows ✓ and links back to
 * itself, the current step carries `aria-current="step"`, and a later step is
 * a disabled button, because finishing this step is the only way to reach it.
 * A phone keeps the marks and drops the labels to the accessibility tree.
 */
export function StepRail({
  label,
  steps,
}: {
  /** The rail's accessible name, already translated. */
  label: string;
  steps: readonly RailStep[];
}) {
  return (
    <nav aria-label={label}>
      <ol className="grid grid-cols-3 overflow-hidden rounded-xl border border-border bg-card">
        {steps.map((step, index) => {
          const body = (
            <>
              <span
                aria-hidden="true"
                className={`inline-flex size-[22px] flex-none items-center justify-center rounded-full border text-[11px] ${SEGMENT_MARK[step.state]}`}
              >
                {step.state === "done" ? "✓" : index + 1}
              </span>
              <span
                className={`min-w-0 max-md:sr-only ${step.state === "done" ? "text-success" : step.state === "current" ? "font-medium text-foreground" : "text-muted-foreground"}`}
              >
                {step.label}
              </span>
              <span className="sr-only">{step.stateLabel}</span>
            </>
          );
          return (
            <li
              key={step.key}
              data-testid="rail-step"
              data-step={step.key}
              data-state={step.state}
              className={`min-w-0 ${index > 0 ? "border-l border-border" : ""} ${step.state === "current" ? "bg-hl" : ""}`}
            >
              {step.state === "done" && step.to !== null ? (
                <SafeLink
                  to={step.to}
                  className={`${segment} hover:bg-hl focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring`}
                >
                  {body}
                </SafeLink>
              ) : step.state === "current" ? (
                <span aria-current="step" className={segment}>
                  {body}
                </span>
              ) : (
                <button
                  type="button"
                  disabled
                  className={`${segment} disabled:cursor-not-allowed`}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
