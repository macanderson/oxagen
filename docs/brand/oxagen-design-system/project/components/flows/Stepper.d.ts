import * as React from "react";

export interface Step {
  label: React.ReactNode;
  description?: React.ReactNode;
}

/**
 * Horizontal step progresser. Completed steps fill with a gradient + check, the
 * active step glows, and connector lines fill as you advance. `current` is the
 * 0-based active index.
 *
 * @startingPoint section="Flows" subtitle="Horizontal step progress indicator" viewport="700x120"
 */
export interface StepperProps {
  steps: Step[];
  current?: number;
  style?: React.CSSProperties;
}

export function Stepper(props: StepperProps): React.ReactElement;
