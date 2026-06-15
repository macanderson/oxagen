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

// Use relative /api/v1 so requests stay same-origin and the Better Auth session
// cookie is forwarded automatically. next.config.mjs rewrites these to the Hono API.
const API_BASE = "/api";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "@oxagen/ui";
import { GithubIcon, RefreshCw, CheckCircle2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type WizardStep = "connect" | "select-repos" | "confirm";

interface Installation {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  avatarUrl: string | null;
}

interface Repository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  description: string | null;
}

const SYNC_DEPTH_OPTIONS = [30, 60, 90, 180] as const;
type SyncDepth = (typeof SYNC_DEPTH_OPTIONS)[number];

// ── Sub-components ─────────────────────────────────────────────────────────────

function Spinner({ className }: { className?: string }) {
  return (
    <RefreshCw
      className={`h-4 w-4 animate-spin ${className ?? ""}`}
      aria-hidden="true"
    />
  );
}

// ── Step 1: Connect ───────────────────────────────────────────────────────────

interface Step1Props {
  orgSlug: string;
  workspaceSlug: string;
  onConnectionCreated: (connectionId: string) => void;
  error: string | null;
}

function Step1Connect({ orgSlug, workspaceSlug, onConnectionCreated, error }: Step1Props) {
  const [loading, setLoading] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);

  const handleConnect = React.useCallback(async () => {
    setLoading(true);
    setLocalError(null);
    try {
      // Step 1a: Create connection row in pending_setup status.
      const createRes = await fetch(
        `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          // Shape is the connection.create contract input. The credential
          // carries only its type — real tokens arrive via the OAuth
          // callback after the GitHub redirect, never through this POST.
          body: JSON.stringify({
            connectorId: "github",
            displayName: "GitHub",
            authCredential: { type: "oauth2_authorization_code" },
            connectionConfig: { organizations: [], syncDepthDays: 90 },
          }),
        },
      );
      if (!createRes.ok) {
        const text = await createRes.text().catch(() => "Unknown error");
        throw new Error(`Failed to create connection: ${text}`);
      }
      const created = (await createRes.json()) as { publicId?: string; connectionId?: string };
      const connectionId = created.publicId ?? created.connectionId;
      if (!connectionId) throw new Error("No connectionId returned from create");

      onConnectionCreated(connectionId);

      // Step 1b: Get the OAuth URL and redirect.
      const authUrlRes = await fetch(
        `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/github/auth-url?connectionId=${connectionId}`,
        { credentials: "include" },
      );
      if (!authUrlRes.ok) {
        throw new Error("Failed to get OAuth URL");
      }
      const { authUrl } = (await authUrlRes.json()) as { authUrl: string };
      window.location.href = authUrl;
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Failed to initiate GitHub connection");
      setLoading(false);
    }
  }, [orgSlug, workspaceSlug, onConnectionCreated]);

  const displayError = localError ?? error;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <GithubIcon className="h-8 w-8 text-foreground" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-semibold text-foreground">Connect your GitHub account</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Authorize Oxagen to read your repositories. You&apos;ll select which repos to sync
            in the next step.
          </p>
        </div>
      </div>

      {displayError && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {displayError}
        </p>
      )}

      <button
        type="button"
        className="flex w-full items-center justify-center gap-2 rounded-md bg-foreground px-4 py-2.5 text-sm font-semibold text-background hover:bg-foreground/90 transition-colors disabled:opacity-50"
        disabled={loading}
        onClick={handleConnect}
        data-testid="github-connect-btn"
      >
        {loading ? <Spinner /> : <GithubIcon className="h-4 w-4" aria-hidden="true" />}
        {loading ? "Redirecting to GitHub…" : "Connect with GitHub"}
      </button>
    </div>
  );
}

// ── Step 2: Select Repos ───────────────────────────────────────────────────────

interface Step2Props {
  orgSlug: string;
  workspaceSlug: string;
  connectionId: string;
  onNext: (selectedInstallationId: string, selectedRepos: string[]) => void;
}

function Step2SelectRepos({ orgSlug, workspaceSlug, connectionId, onNext }: Step2Props) {
  const [installations, setInstallations] = React.useState<Installation[]>([]);
  const [installationsLoading, setInstallationsLoading] = React.useState(true);
  const [installationsError, setInstallationsError] = React.useState<string | null>(null);

  const [selectedInstallationId, setSelectedInstallationId] = React.useState<number | null>(null);

  const [repositories, setRepositories] = React.useState<Repository[]>([]);
  const [reposLoading, setReposLoading] = React.useState(false);
  const [reposError, setReposError] = React.useState<string | null>(null);

  const [selectedRepos, setSelectedRepos] = React.useState<Set<string>>(new Set());

  // Fetch installations on mount.
  React.useEffect(() => {
    let cancelled = false;
    setInstallationsLoading(true);
    setInstallationsError(null);

    fetch(
      `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/github/installations?connectionId=${connectionId}`,
      { credentials: "include" },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load organizations: ${res.status}`);
        return res.json() as Promise<{ installations: Installation[] }>;
      })
      .then((data) => {
        if (!cancelled) {
          setInstallations(data.installations);
          setInstallationsLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setInstallationsError(e instanceof Error ? e.message : "Failed to load organizations");
          setInstallationsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [orgSlug, workspaceSlug, connectionId]);

  // Fetch repositories when an installation is selected.
  React.useEffect(() => {
    if (selectedInstallationId === null) {
      setRepositories([]);
      return;
    }

    let cancelled = false;
    setReposLoading(true);
    setReposError(null);
    setSelectedRepos(new Set());

    fetch(
      `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/github/installations/${selectedInstallationId}/repositories?connectionId=${connectionId}`,
      { credentials: "include" },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load repositories: ${res.status}`);
        return res.json() as Promise<{ repositories: Repository[]; totalCount: number }>;
      })
      .then((data) => {
        if (!cancelled) {
          setRepositories(data.repositories);
          setReposLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setReposError(e instanceof Error ? e.message : "Failed to load repositories");
          setReposLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [orgSlug, workspaceSlug, connectionId, selectedInstallationId]);

  const allSelected =
    repositories.length > 0 && repositories.every((r) => selectedRepos.has(r.fullName));

  const toggleAll = () => {
    if (allSelected) {
      setSelectedRepos(new Set());
    } else {
      setSelectedRepos(new Set(repositories.map((r) => r.fullName)));
    }
  };

  const toggleRepo = (fullName: string) => {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) {
        next.delete(fullName);
      } else {
        next.add(fullName);
      }
      return next;
    });
  };

  const selectedInstallation = installations.find((i) => i.id === selectedInstallationId);

  const handleNext = () => {
    if (selectedInstallationId === null || selectedRepos.size === 0) return;
    onNext(String(selectedInstallationId), Array.from(selectedRepos));
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Org list */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          Select organization
        </p>
        {installationsLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner />
          </div>
        ) : installationsError ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {installationsError}
          </p>
        ) : installations.length === 0 ? (
          <p className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
            No GitHub App installations found. Install the GitHub App on your account or organization first.
          </p>
        ) : (
          <ul
            className="max-h-36 overflow-y-auto rounded-lg border border-border/60 divide-y divide-border/40"
            data-testid="installation-list"
          >
            {installations.map((installation) => (
              <li key={installation.id}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 ${
                    selectedInstallationId === installation.id
                      ? "bg-primary/10 text-primary"
                      : "text-foreground"
                  }`}
                  onClick={() => setSelectedInstallationId(installation.id)}
                  data-testid={`installation-item-${installation.id}`}
                  data-selected={selectedInstallationId === installation.id ? "" : undefined}
                >
                  {installation.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- GitHub avatars are external
                    <img
                      src={installation.avatarUrl}
                      alt={installation.accountLogin}
                      className="h-5 w-5 rounded-full"
                    />
                  ) : (
                    <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted">
                      <GithubIcon className="h-3 w-3" aria-hidden="true" />
                    </div>
                  )}
                  <span className="flex-1 truncate font-medium">{installation.accountLogin}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {installation.accountType}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Repo list */}
      {selectedInstallationId !== null && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">
              Select repositories
              {selectedInstallation?.repositorySelection === "all" && (
                <span className="ml-1 text-[11px] text-blue-500">
                  (all repositories granted)
                </span>
              )}
            </p>
            {repositories.length > 0 && (
              <button
                type="button"
                className="text-[11px] text-primary hover:underline"
                onClick={toggleAll}
                data-testid="select-all-repos-btn"
              >
                {allSelected ? "Deselect all" : "Select all"}
              </button>
            )}
          </div>

          {reposLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner />
            </div>
          ) : reposError ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {reposError}
            </p>
          ) : repositories.length === 0 ? (
            <p className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
              No repositories found for this installation.
            </p>
          ) : (
            <ul
              className="max-h-48 overflow-y-auto rounded-lg border border-border/60 divide-y divide-border/40"
              data-testid="repository-list"
            >
              {repositories.map((repo) => {
                const isChecked = selectedRepos.has(repo.fullName);
                return (
                  <li key={repo.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleRepo(repo.fullName)}
                        className="h-3.5 w-3.5 rounded border-border accent-primary"
                        data-testid={`repo-checkbox-${repo.name}`}
                      />
                      <div className="flex flex-1 items-center gap-2 min-w-0">
                        <span className="flex-1 truncate text-sm font-medium text-foreground">
                          {repo.name}
                        </span>
                        <span
                          className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            repo.private
                              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                              : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                          }`}
                        >
                          {repo.private ? "Private" : "Public"}
                        </span>
                        {repo.language && (
                          <span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {repo.language}
                          </span>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <DialogFooter className="mt-2">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          disabled={selectedInstallationId === null || selectedRepos.size === 0}
          onClick={handleNext}
          data-testid="select-repos-next-btn"
        >
          Continue
        </button>
      </DialogFooter>
    </div>
  );
}

// ── Step 3: Confirm ────────────────────────────────────────────────────────────

interface Step3Props {
  orgSlug: string;
  workspaceSlug: string;
  connectionId: string;
  selectedInstallationId: string;
  selectedRepos: string[];
  onSuccess: () => void;
}

function Step3Confirm({
  orgSlug,
  workspaceSlug,
  connectionId,
  selectedInstallationId,
  selectedRepos,
  onSuccess,
}: Step3Props) {
  const [syncDepth, setSyncDepth] = React.useState<SyncDepth>(90);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleStartSync = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/${connectionId}/mappings`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId,
            mappings: [
              {
                sourceRecordType: "repository",
                oxagenEntityType: "source_repository",
                propertyMappings: {
                  full_name: "display_name",
                  html_url: "url",
                  description: "description",
                  language: "language",
                },
              },
            ],
            activateConnection: true,
            installationId: selectedInstallationId,
            selectedRepos,
            syncDepthDays: syncDepth,
          }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(`Failed to start sync: ${text}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start sync");
      setLoading(false);
    }
  }, [
    orgSlug,
    workspaceSlug,
    connectionId,
    selectedInstallationId,
    selectedRepos,
    syncDepth,
    onSuccess,
  ]);

  return (
    <div className="flex flex-col gap-5">
      {/* Summary */}
      <div className="rounded-lg border border-border/60 bg-card/50 p-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Organization</span>
            <span className="font-medium text-foreground">
              Installation #{selectedInstallationId}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Repositories</span>
            <span className="font-medium text-foreground">
              {selectedRepos.length} selected
            </span>
          </div>
        </div>
        {selectedRepos.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {selectedRepos.slice(0, 6).map((repo) => (
              <li
                key={repo}
                className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {repo}
              </li>
            ))}
            {selectedRepos.length > 6 && (
              <li className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                +{selectedRepos.length - 6} more
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Sync depth */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          Sync history depth: <span className="text-foreground font-semibold">{syncDepth} days</span>
        </p>
        <div className="flex gap-1.5">
          {SYNC_DEPTH_OPTIONS.map((depth) => (
            <button
              key={depth}
              type="button"
              className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                syncDepth === depth
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/60 bg-card text-muted-foreground hover:bg-muted"
              }`}
              onClick={() => setSyncDepth(depth)}
              data-testid={`sync-depth-${depth}`}
            >
              {depth}d
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          disabled={loading}
          onClick={handleStartSync}
          data-testid="start-sync-btn"
        >
          {loading ? (
            <>
              <Spinner />
              Starting sync…
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Start Sync
            </>
          )}
        </button>
      </DialogFooter>
    </div>
  );
}

// ── Success state ─────────────────────────────────────────────────────────────

function SuccessState({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30">
        <CheckCircle2 className="h-6 w-6 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-foreground">Sync started!</p>
        <p className="text-xs text-muted-foreground">
          Your GitHub repositories are being indexed. This may take a few minutes.
          You can check the status on the Sources page.
        </p>
      </div>
      <button
        type="button"
        className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        onClick={onClose}
        data-testid="wizard-done-btn"
      >
        Done
      </button>
    </div>
  );
}

// ── Main Wizard ───────────────────────────────────────────────────────────────

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
  const [selectedRepos, setSelectedRepos] = React.useState<string[]>([]);
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
          setSelectedRepos([]);
          setConnectionError(null);
          setDone(false);
        }, 300);
      }
    },
    [onClose, initialConnectionId],
  );

  const stepTitles: Record<WizardStep, string> = {
    connect: "Connect GitHub",
    "select-repos": "Select Repositories",
    confirm: "Confirm & Sync",
  };

  const stepDescriptions: Record<WizardStep, string> = {
    connect: "Authorize Oxagen to access your GitHub account.",
    "select-repos": "Choose which repositories to include in your knowledge graph.",
    confirm: "Review your selection and start the initial sync.",
  };

  const handleReposSelected = (installationId: string, repos: string[]) => {
    setSelectedInstallationId(installationId);
    setSelectedRepos(repos);
    setStep("confirm");
  };

  const handleSuccess = () => {
    setDone(true);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup
        className="max-w-md"
        data-testid="github-connection-wizard"
      >
        <DialogHeader>
          <DialogTitle>
            {done ? "GitHub Connected" : stepTitles[step]}
          </DialogTitle>
          {!done && (
            <DialogDescription>{stepDescriptions[step]}</DialogDescription>
          )}
        </DialogHeader>

        {/* Step indicator */}
        {!done && (
          <div className="flex items-center gap-1.5 py-1">
            {(["connect", "select-repos", "confirm"] as WizardStep[]).map((s, idx) => (
              <React.Fragment key={s}>
                <div
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    step === s
                      ? "bg-primary"
                      : (["connect", "select-repos", "confirm"] as WizardStep[]).indexOf(step) > idx
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
