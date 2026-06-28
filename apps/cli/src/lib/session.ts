/**
 * Session helpers for the account-required gate (ADR-019 §4).
 *
 * The CLI requires an active Oxagen session (token + org + workspace) before
 * any agent-path command runs. Call `requireSession()` at the top of the
 * default action in index.tsx; it exits 1 with a clear error if the session
 * is missing so the user knows exactly what to do next.
 */
import { getApiUrl, getOrgId, getToken, getWorkspaceId } from "./config.js";

export interface Session {
  token: string;
  orgSlug: string;
  workspaceSlug: string;
  apiUrl: string;
}

/**
 * Load the session from config/env.
 * Returns null if any required field (token, orgSlug, workspaceSlug) is absent.
 */
export function loadSession(): Session | null {
  const token = getToken();
  const orgSlug = getOrgId();
  const workspaceSlug = getWorkspaceId();
  if (!token || !orgSlug || !workspaceSlug) return null;
  return { token, orgSlug, workspaceSlug, apiUrl: getApiUrl() };
}

/**
 * Require a valid session or exit 1 with a clear actionable error message.
 *
 * Wire this in front of the default one-shot action, the interactive REPL
 * launch, and the `--agent` path — all agent-execution paths. Non-agent
 * utility commands (config, settings, login, logout, etc.) bypass this gate.
 */
export function requireSession(): Session {
  const token = getToken();
  const orgSlug = getOrgId();
  const workspaceSlug = getWorkspaceId();

  if (!token || !orgSlug || !workspaceSlug) {
    const missing: string[] = [];
    if (!token) missing.push("token");
    if (!orgSlug) missing.push("org");
    if (!workspaceSlug) missing.push("workspace");

    process.stderr.write(
      `Not logged in (missing: ${missing.join(", ")}).\n` +
        `Run \`oxagen login\` to authenticate with your Oxagen account.\n`,
    );
    process.exit(1);
  }

  return { token, orgSlug, workspaceSlug, apiUrl: getApiUrl() };
}
