/**
 * github-connection-wizard-types.ts — Shared types and constants for the GitHub
 * connection wizard.
 */

// ── Step ──────────────────────────────────────────────────────────────────────

export type WizardStep = "connect" | "select-repos" | "confirm";

// ── API shapes ────────────────────────────────────────────────────────────────

export interface Installation {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  avatarUrl: string | null;
  /** GitHub page for managing which repos this org grants the App. May be null. */
  htmlUrl: string | null;
}

/** Response shape of GET /connections/github/installations. */
export interface InstallationsResponse {
  installations: Installation[];
  /** GitHub URL to add/remove which orgs & repos the App is installed into. */
  manageUrl: string;
}

export interface Repository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  description: string | null;
}

// ── Sync depth ────────────────────────────────────────────────────────────────

export const SYNC_DEPTH_OPTIONS = [30, 60, 90, 180] as const;
export type SyncDepth = (typeof SYNC_DEPTH_OPTIONS)[number];

// ── API base ──────────────────────────────────────────────────────────────────

// Use relative /api/v1 so requests stay same-origin and the Better Auth session
// cookie is forwarded automatically. next.config.mjs rewrites these to the Hono API.
export const API_BASE = "/api";

// ── Pending-connection handoff across the GitHub redirect ───────────────────────

/**
 * The wizard creates a `pending_setup` connection BEFORE redirecting the browser
 * to GitHub, then needs to resume Step 2 with that exact connection when GitHub
 * redirects back. The OAuth-callback leg round-trips our signed `state` and so
 * lands back on `…/knowledge/sources?setup=github&connectionId=<id>` — the id is
 * in the URL. But when the App is ALREADY installed, GitHub treats the action as
 * an installation *update* and uses the App's stateless **Setup URL** leg
 * (`/github/setup`, `setup_action=update`, no OAuth `state`), which can only
 * redirect to `…/knowledge/sources?setup=github` — the connection id is lost.
 *
 * The browser is the only party that reliably knows which connection the user is
 * mid-setup on, so we stash it in `sessionStorage` right before leaving for
 * GitHub and read it back on return. sessionStorage survives the same-tab
 * cross-origin round trip (it is per-origin, restored when the tab returns to our
 * origin) and is auto-discarded when the tab closes, so an abandoned flow leaves
 * no durable state.
 */
const PENDING_GITHUB_CONNECTION_KEY = "oxagen.github.pendingConnection";

export interface PendingGithubConnection {
  connectionId: string;
  orgSlug: string;
  workspaceSlug: string;
}

/** Persist the in-progress connection just before redirecting to GitHub. */
export function storePendingGithubConnection(pending: PendingGithubConnection): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(PENDING_GITHUB_CONNECTION_KEY, JSON.stringify(pending));
  } catch {
    // sessionStorage can throw (private mode / quota) — a lost handoff merely
    // means the wizard restarts at Step 1, never a crash.
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
