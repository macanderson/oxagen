// The rail both flows draw: the gate's three steps over the real pages
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
