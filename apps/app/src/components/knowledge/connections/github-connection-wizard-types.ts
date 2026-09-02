/**
 * github-connection-wizard-types.ts — Shared types and constants for the GitHub
 * connection wizard.
 */

// ── Step ──────────────────────────────────────────────────────────────────────

export type WizardStep = "gate" | "select-repos" | "confirm";

// ── API shapes — sourced from the shared lib; re-exported here so step2/step3
//    and existing callers keep their current import paths unchanged ─────────────

export { API_BASE } from "@/lib/github";
export type {
  Installation,
  InstallationsResponse,
  Repository,
} from "@/lib/github";

// ── Sync depth ────────────────────────────────────────────────────────────────

export const SYNC_DEPTH_OPTIONS = [30, 60, 90, 180] as const;
export type SyncDepth = (typeof SYNC_DEPTH_OPTIONS)[number];

// ── Pending-connection handoff across the GitHub redirect ───────────────────────

/**
 * The wizard creates a `pending_setup` connection before advancing to Step 2,
 * then needs to resume with that exact connection when the workspace is
 * returned to via the GitHub OAuth callback or the stateless Setup-URL leg.
 * The OAuth leg carries our signed `state` and lands on
 * `…/knowledge/sources?setup=github&connectionId=<id>`; the Setup-URL leg
 * (`setup_action=update`) is stateless and lands on
 * `…/knowledge/sources?setup=github` — the id is lost.
 *
 * The browser is the only party that reliably knows which connection is
 * mid-setup, so we stash it in `sessionStorage` before any redirect and read
 * it back on return. sessionStorage survives the same-tab cross-origin round
 * trip and is auto-discarded when the tab closes.
 */
const PENDING_GITHUB_CONNECTION_KEY = "oxagen.github.pendingConnection";

export interface PendingGithubConnection {
  connectionId: string;
  orgSlug: string;
  workspaceSlug: string;
}

/** Persist the in-progress connection just before leaving for GitHub. */
export function storePendingGithubConnection(
  pending: PendingGithubConnection,
): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      PENDING_GITHUB_CONNECTION_KEY,
      JSON.stringify(pending),
    );
  } catch {
    // sessionStorage can throw (private mode / quota) — a lost handoff merely
    // means the wizard restarts at the gate, never a crash.
  }
}

/** Read the in-progress connection stashed before the GitHub redirect, if any. */
export function readPendingGithubConnection(): PendingGithubConnection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_GITHUB_CONNECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingGithubConnection>;
    if (
      typeof parsed.connectionId === "string" &&
      typeof parsed.orgSlug === "string" &&
      typeof parsed.workspaceSlug === "string"
    ) {
      return {
        connectionId: parsed.connectionId,
        orgSlug: parsed.orgSlug,
        workspaceSlug: parsed.workspaceSlug,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Clear the handoff once the connection has been resumed or the flow completes. */
export function clearPendingGithubConnection(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PENDING_GITHUB_CONNECTION_KEY);
  } catch {
    // best-effort cleanup
  }
}
