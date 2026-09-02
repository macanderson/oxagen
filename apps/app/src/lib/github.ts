/**
 * github.ts — Shared client-side types and helpers for the Oxagen GitHub App
 * connection, used by BOTH the workspace settings GitHub panel and the knowledge
 * Sources repo picker.
 *
 * The install (1 workspace = 1 app install) lives in Workspace Settings → GitHub;
 * the Sources tab only SELECTS repos from an already-connected install. Both
 * surfaces talk to the same workspace-scoped API under
 * `/api/v1/{org}/{ws}/connections/github/*`, so the wire shapes and the status
 * fetch live here rather than being duplicated per feature.
 */

// Use relative /api so requests stay same-origin and the Better Auth session
// cookie is forwarded automatically. next.config rewrites these to the Hono API.
export const API_BASE = "/api";

// ── Wire shapes ─────────────────────────────────────────────────────────────

/** A GitHub App installation (one GitHub org/user the App is installed on). */
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

/** A repository reachable through a specific installation. */
export interface Repository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  description: string | null;
}

/**
 * Response shape of GET /connections/github/status — the workspace's GitHub App
 * connection state for the settings surface and the sources gate.
 */
export interface GithubStatusResponse {
  /** True once the workspace's org has a usable GitHub OAuth token. */
  connected: boolean;
  /** Installations the connection can reach (empty when not connected). */
  installations: Installation[];
  /** GitHub URL to add/remove which orgs the App is installed into. */
  manageUrl: string;
  /**
   * Signed GitHub `login/oauth/authorize` (identity) URL — the primary
   * "Connect GitHub" destination. Always returns to our callback with code+state
   * even when the App is already installed on the target org, so a SECOND Oxagen
   * tenant can establish its own token and connect. Prefer this over `installUrl`.
   */
  identityUrl: string;
  /**
   * Signed GitHub App install URL (`installations/new`) — installs the App on a
   * NEW org or changes which repos it can access. Secondary affordance only;
   * use `identityUrl` to establish a connection.
   */
  installUrl: string;
}

// ── Status fetch ────────────────────────────────────────────────────────────

/**
 * Fetch the workspace's GitHub connection status. Same-origin with credentials so
 * the session cookie rides along. Throws on a non-2xx so callers can surface a
 * distinct error state rather than silently treating it as "not connected".
 */
export async function fetchGithubStatus(
  orgSlug: string,
  workspaceSlug: string,
  signal?: AbortSignal,
): Promise<GithubStatusResponse> {
  const res = await fetch(
    `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/github/status`,
    { credentials: "include", signal },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Failed to load GitHub status (${res.status})`,
    );
  }
  return (await res.json()) as GithubStatusResponse;
}
