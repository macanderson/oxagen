"use client";

/**
 * wizard-progress.tsx — 5-dot step indicator for the "Connect a source"
 * wizard. Same visual language as
 * apps/app/src/components/knowledge/connections/github-connection-wizard.tsx's
 * inline step indicator, generalized to WIZARD_STEPS.
 */

import {
  WIZARD_STEPS,
  WIZARD_STEP_LABELS,
  type WizardStepId,
} from "./wizard-types";

export interface WizardProgressProps {
  currentStep: WizardStepId;
}

export function WizardProgress({ currentStep }: WizardProgressProps) {
  const currentIndex = WIZARD_STEPS.indexOf(currentStep);

  return (
    <div className="flex flex-col gap-2" data-testid="wizard-progress">
      <div className="flex items-center gap-1.5">
        {WIZARD_STEPS.map((step, idx) => (
          <div
            key={step}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              step === currentStep
                ? "bg-primary"
                : currentIndex > idx
                  ? "bg-primary/40"
                  : "bg-muted"
            }`}
            data-testid={`wizard-progress-dot-${step}`}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          Step {currentIndex + 1} of {WIZARD_STEPS.length}
        </span>
        <span className="font-medium text-foreground">
          {WIZARD_STEP_LABELS[currentStep]}
        </span>
      </div>
    </div>
  );
}
