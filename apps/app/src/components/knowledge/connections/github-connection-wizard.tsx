"use client";

/**
 * github-connection-wizard.tsx — Multi-step GitHub source connection wizard.
 *
 * Gate ("gate"): Checks whether the workspace GitHub App install exists.
 *   - Not connected → renders GitHubInstallGate, directing the user to
 *     Workspace Settings → GitHub (install lives there; 1 workspace = 1 install).
 *   - Connected → creates a pending connection row, then advances automatically.
 *   - Error → shows an inline error with a retry button.
 *
 * Step 1 ("select-repos"): Cascading org → repo selector.
 * Step 2 ("confirm"): Review + sync depth + "Start Sync" button.
 *
 * With `initialConnectionId` (OAuth / settings redirect-return): skips the
 * gate entirely and starts at select-repos for back-compat.
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
import {
  type WizardStep,
  storePendingGithubConnection,
} from "./github-connection-wizard-types";
import { GitHubInstallGate } from "./github-connection-wizard-step1";
import {
  Step2SelectRepos,
  type SelectedRepoMeta,
} from "./github-connection-wizard-step2";
import { Step3Confirm } from "./github-connection-wizard-step3";
import { SuccessState } from "./github-connection-wizard-success";
import { Spinner } from "./github-connection-wizard-spinner";
import { fetchGithubStatus, API_BASE } from "@/lib/github";

// ── Public API ────────────────────────────────────────────────────────────────

export interface GitHubConnectionWizardProps {
  open: boolean;
  onClose: () => void;
  orgSlug: string;
  workspaceSlug: string;
  /**
   * When set, the wizard starts at select-repos (user has returned from the
   * OAuth callback or the settings connect flow). Value is the publicId of the
   * connection that was created before the redirect.
   */
  initialConnectionId?: string;
}

// The two user-visible steps beyond the gate. Used for the step indicator.
const VISIBLE_STEPS = ["select-repos", "confirm"] as const;

const STEP_TITLES: Record<WizardStep, string> = {
  gate: "Connect GitHub",
  "select-repos": "Select Repositories",
  confirm: "Confirm & Sync",
};

const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
  gate: "The Oxagen GitHub App must be installed for this workspace.",
  "select-repos":
    "Choose which repositories to include in your knowledge graph.",
  confirm: "Review your selection and start the initial sync.",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a `pending_setup` GitHub connection row and returns its publicId.
 * Moved from Step1Connect to the orchestrator so it only fires once the App
 * is confirmed installed (status.connected === true).
 */
async function createPendingGithubConnection(
  orgSlug: string,
  workspaceSlug: string,
): Promise<string> {
  const res = await fetch(
    `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      // The credential carries only its type here — real tokens arrive via the
      // OAuth callback, never through this POST.
      body: JSON.stringify({
        connectorId: "github",
        displayName: "GitHub",
        authCredential: { type: "oauth2_authorization_code" },
        connectionConfig: { organizations: [], syncDepthDays: 90 },
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`Failed to create connection: ${text}`);
  }
  const created = (await res.json()) as {
    publicId?: string;
    connectionId?: string;
  };
  const id = created.publicId ?? created.connectionId;
  if (!id) throw new Error("No connectionId returned from server");
  return id;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export function GitHubConnectionWizard({
  open,
  onClose,
  orgSlug,
  workspaceSlug,
  initialConnectionId,
}: GitHubConnectionWizardProps) {
  const hasResume = Boolean(initialConnectionId);

  const [step, setStep] = React.useState<WizardStep>(
    hasResume ? "select-repos" : "gate",
  );
  const [connectionId, setConnectionId] = React.useState<string | null>(
    initialConnectionId ?? null,
  );
  const [selectedInstallationId, setSelectedInstallationId] = React.useState<
    string | null
  >(null);
  const [selectedRepos, setSelectedRepos] = React.useState<SelectedRepoMeta[]>(
    [],
  );

  // Gate sub-states: checking (spinner), not-connected (GitHubInstallGate),
  // error (inline error + retry button).
  const [gateState, setGateState] = React.useState<
    "checking" | "not-connected" | "error"
  >("checking");
  const [gateError, setGateError] = React.useState<string | null>(null);
  // Incrementing this triggers a re-run of the status-check effect (retry).
  const [retryNonce, setRetryNonce] = React.useState(0);

  const [done, setDone] = React.useState(false);

  // Check GitHub App status when the wizard opens without an existing connection.
  // Connected: create the pending_setup row, stash the handoff, advance to step.
  // Not connected: show the install gate pointing to Workspace Settings → GitHub.
  React.useEffect(() => {
    if (!open || hasResume) return;

    const controller = new AbortController();
    setGateState("checking");
    setGateError(null);

    (async () => {
      try {
        const status = await fetchGithubStatus(
          orgSlug,
          workspaceSlug,
          controller.signal,
        );
        if (controller.signal.aborted) return;

        if (!status.connected) {
          setGateState("not-connected");
          return;
        }

        // App is installed — create the pending connection and proceed directly
        // to repo selection without requiring another OAuth redirect.
        const id = await createPendingGithubConnection(orgSlug, workspaceSlug);
        if (controller.signal.aborted) return;

        // Stash the handoff so the wizard can resume at select-repos even if
        // GitHub's stateless Setup-URL leg drops the connectionId from the URL.
        storePendingGithubConnection({
          connectionId: id,
          orgSlug,
          workspaceSlug,
        });
        setConnectionId(id);
        setStep("select-repos");
      } catch (e) {
        if (controller.signal.aborted) return;
        setGateError(
          e instanceof Error ? e.message : "Failed to check GitHub status",
        );
        setGateState("error");
      }
    })();

    return () => {
      controller.abort();
    };
    // retryNonce re-runs the check when the user clicks "Try again".
  }, [open, hasResume, orgSlug, workspaceSlug, retryNonce]);

  // Reset to the initial gate state when the dialog closes (without an existing
  // connection) so reopening it re-checks status rather than showing stale UI.
  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        onClose();
        // Defer reset so the closing animation plays out before state changes.
        setTimeout(() => {
          if (!hasResume) {
            setStep("gate");
            setGateState("checking");
            setConnectionId(null);
            setGateError(null);
          }
          setSelectedInstallationId(null);
          setSelectedRepos([] as SelectedRepoMeta[]);
          setDone(false);
        }, 300);
      }
    },
    [onClose, hasResume],
  );

  const handleReposSelected = (
    installationId: string,
    repos: SelectedRepoMeta[],
  ) => {
    setSelectedInstallationId(installationId);
    setSelectedRepos(repos);
    setStep("confirm");
  };

  const handleSuccess = () => {
    setDone(true);
  };

  const isGate = step === "gate";
  const currentVisibleIndex = VISIBLE_STEPS.indexOf(
    step as (typeof VISIBLE_STEPS)[number],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-md" data-testid="github-connection-wizard">
        <DialogHeader>
          <DialogTitle>
            {done ? "GitHub Connected" : STEP_TITLES[step]}
          </DialogTitle>
          {!done && (
            <DialogDescription>{STEP_DESCRIPTIONS[step]}</DialogDescription>
          )}
        </DialogHeader>

        {/* Step indicator — only shown for the two user-facing steps; hidden on
            the gate so it doesn't imply progress before the install check. */}
        {!done && !isGate && (
          <div className="flex items-center gap-1.5 py-1">
            {VISIBLE_STEPS.map((s, idx) => (
              <div
                key={s}
                className={`h-1.5 flex-1 rounded-full transition-colors ${
                  step === s
                    ? "bg-primary"
                    : currentVisibleIndex > idx
                      ? "bg-primary/40"
                      : "bg-muted"
                }`}
              />
            ))}
          </div>
        )}

        <DialogPanel>
          {done ? (
            <SuccessState onClose={onClose} />
          ) : isGate ? (
            gateState === "checking" ? (
              <div className="flex h-32 items-center justify-center">
                <Spinner />
              </div>
            ) : gateState === "error" ? (
              <div className="flex flex-col gap-4 py-4">
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {gateError ??
                    "Failed to check GitHub status. Please try again."}
                </p>
                <button
                  type="button"
                  className="rounded-md border border-border/60 bg-card px-4 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors"
                  onClick={() => setRetryNonce((n) => n + 1)}
                  data-testid="github-gate-retry-btn"
                >
                  Try again
                </button>
              </div>
            ) : (
              // gateState === "not-connected"
              <GitHubInstallGate
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                onClose={onClose}
              />
            )
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
              This step lost the connection it was set up with
              {connectionId ? " or the organization you picked" : ""}. Close the
              dialog and start the connection again.
            </p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
