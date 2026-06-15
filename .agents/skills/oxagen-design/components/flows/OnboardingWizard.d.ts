import * as React from "react";

export interface WizardStep {
  label: React.ReactNode;
  description?: React.ReactNode;
  /** Step body. Receives { index, goNext, goBack, data, setData }. */
  render: React.ReactNode | ((ctx: WizardContext) => React.ReactNode);
}

export interface WizardContext {
  index: number;
  goNext: () => void;
  goBack: () => void;
  data: Record<string, any>;
  setData: (patch: Record<string, any>) => void;
}

/**
 * Multi-step onboarding flow: Stepper header, animated slide+fade step
 * transitions, and Back/Continue controls. Calls `onComplete(data)` on the
 * final step.
 *
 * @startingPoint section="Flows" subtitle="Multi-step onboarding wizard with stepper" viewport="640x460"
 */
export interface OnboardingWizardProps {
  steps: WizardStep[];
  onComplete?: (data: Record<string, any>) => void;
  initialData?: Record<string, any>;
  style?: React.CSSProperties;
}

export function OnboardingWizard(props: OnboardingWizardProps): React.ReactElement;
