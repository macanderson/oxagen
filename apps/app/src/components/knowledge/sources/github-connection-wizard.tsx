"use client";

/**
 * github-connection-wizard.tsx — Multi-step GitHub source connection wizard.
 *
 * Step 1 ("Connect"): Create connection + redirect to GitHub OAuth.
 * Step 2 ("Select Repos"): Cascading org → repo selector (renders when OAuth returns).
 * Step 3 ("Confirm"): Review + sync depth + "Start Sync" button.
 *
 * API calls go through the Hono API (NEXT_PUBLIC_API_URL) at /v1/{org}/{ws}/...
 * not the Next.js app — the Next.js app doesn't have these connection routes.
 */

import * as React from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "@oxagen/ui";
import { type WizardStep } from "./github-connection-wizard-types";
import { Step1Connect } from "./github-connection-wizard-step1";
import { Step2SelectRepos, type SelectedRepoMeta } from "./github-connection-wizard-step2";
import { Step3Confirm } from "./github-connection-wizard-step3";
import { SuccessState } from "./github-connection-wizard-success";

// ── Public API ────────────────────────────────────────────────────────────────

export interface GitHubConnectionWizardProps {
  open: boolean;
  onClose: () => void;
  orgSlug: string;
  workspaceSlug: string;
  /**
   * When set, the wizard starts at Step 2 (user has returned from OAuth).
   * Value is the publicId of the connection that was created before the OAuth redirect.
   */
  initialConnectionId?: string;
}

const WIZARD_STEPS = ["connect", "select-repos", "confirm"] as WizardStep[];

const STEP_TITLES: Record<WizardStep, string> = {
  connect: "Connect GitHub",
  "select-repos": "Select Repositories",
  confirm: "Confirm & Sync",
};

const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  connect: "Authorize Oxagen to access your GitHub account.",
  "select-repos": "Choose which repositories to include in your knowledge graph.",
  confirm: "Review your selection and start the initial sync.",
};

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function GitHubConnectionWizard({
  open,
  onClose,
  orgSlug,
  workspaceSlug,
  initialConnectionId,
}: GitHubConnectionWizardProps) {
  // Determine initial step based on whether we have a connectionId (post-OAuth return).
  const [step, setStep] = React.useState<WizardStep>(
    initialConnectionId ? "select-repos" : "connect",
  );
  const [connectionId, setConnectionId] = React.useState<string | null>(
    initialConnectionId ?? null,
  );
  const [selectedInstallationId, setSelectedInstallationId] = React.useState<string | null>(null);
  const [selectedRepos, setSelectedRepos] = React.useState<SelectedRepoMeta[]>([]);
  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  // Reset state when dialog is closed and re-opened fresh.
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        onClose();
        // Defer reset so the closing animation plays out.
        setTimeout(() => {
          if (!initialConnectionId) {
            setStep("connect");
            setConnectionId(null);
          }
          setSelectedInstallationId(null);
          setSelectedRepos([] as SelectedRepoMeta[]);
          setConnectionError(null);
          setDone(false);
        }, 300);
      }
    },
    [onClose, initialConnectionId],
  );

  const handleReposSelected = (installationId: string, repos: SelectedRepoMeta[]) => {
    setSelectedInstallationId(installationId);
    setSelectedRepos(repos);
    setStep("confirm");
  };

  const handleSuccess = () => {
    setDone(true);
  };

  const currentStepIndex = WIZARD_STEPS.indexOf(step);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup
        className="max-w-md"
        data-testid="github-connection-wizard"
      >
        <DialogHeader>
          <DialogTitle>
            {done ? "GitHub Connected" : STEP_TITLES[step]}
          </DialogTitle>
          {!done && (
            <DialogDescription>{STEP_DESCRIPTIONS[step]}</DialogDescription>
          )}
        </DialogHeader>

        {/* Step indicator */}
        {!done && (
          <div className="flex items-center gap-1.5 py-1">
            {WIZARD_STEPS.map((s, idx) => (
              <React.Fragment key={s}>
                <div
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    step === s
                      ? "bg-primary"
                      : currentStepIndex > idx
                        ? "bg-primary/40"
                        : "bg-muted"
                  }`}
                />
              </React.Fragment>
            ))}
          </div>
        )}

        <DialogPanel>
          {done ? (
            <SuccessState onClose={onClose} />
          ) : step === "connect" ? (
            <Step1Connect
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              onConnectionCreated={(id) => setConnectionId(id)}
              error={connectionError}
            />
          ) : step === "select-repos" && connectionId ? (
            <Step2SelectRepos
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              connectionId={connectionId}
              onNext={handleReposSelected}
            />
          ) : step === "confirm" && connectionId && selectedInstallationId ? (
            <Step3Confirm
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              connectionId={connectionId}
              selectedInstallationId={selectedInstallationId}
              selectedRepos={selectedRepos}
              onSuccess={handleSuccess}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Something went wrong. Please close and try again.
            </p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
