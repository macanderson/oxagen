/**
 * Auth commands: `oxagen login` and `oxagen logout`.
 *
 * Login default (interactive TTY, no --token): opens a browser-based PKCE
 * OAuth flow via `browserLogin` in lib/loopback-login.ts. The authorize page
 * lives at ${appUrl}/cli/authorize; the token exchange hits
 * POST ${apiUrl}/v1/auth/cli/token. On success, the returned
 * { token, orgSlug, workspaceSlug } is persisted to ~/.config/oxagen/config.json.
 *
 * Headless / CI fallback: pass --token (and optionally --org / --workspace) to
 * skip the browser entirely. If the flags are omitted but we are NOT on a TTY,
 * the command exits with an error. Pass --no-browser to force the token-prompt
 * flow even on an interactive TTY.
 *
 * Validation endpoint (token flow): GET /v1/user/preferences/read
 *   - Requires a valid Bearer API key (auth middleware validates the key).
 *   - Returns 200 for a recognised key; 401 for an invalid or expired key.
 *   - Does not require an org/workspace path parameter — the API key itself
 *     carries the scope, so this works as a pure "is this key valid?" probe.
 *
 * BYOK AI removal (AI_GATEWAY_API_KEY → platform-routed AI) is deferred to
 * ADR-019 task B4. This command establishes the session + account-required
 * gate; the AI transport stays BYOK for now.
 */
import * as readline from "node:readline/promises";
import {
  getApiUrl,
  getAppUrl,
  getOrgId,
  getToken,
  getWorkspaceId,
  readConfig,
  writeConfig,
  clearConfig,
} from "../lib/config.js";

export interface LoginOptions {
  token?: string;
  org?: string;
  workspace?: string;
  /**
   * `false` when --no-browser is passed; `true` (default) otherwise.
   * Commander sets this to false when the user passes `--no-browser`.
   */
  browser?: boolean;
}

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "…" + token.slice(-4);
}

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Validate a platform API token by calling GET /v1/user/preferences/read.
 * Returns true when the key is recognised by the platform (HTTP 200).
 */
export async function validatePlatformToken(
  token: string,
  apiUrl: string,
): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/v1/user/preferences/read`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    process.stderr.write(
      `Network error contacting ${apiUrl}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
  return res.ok;
}

export async function handleLogin(opts: LoginOptions): Promise<void> {
  const apiUrl = getApiUrl();
  const appUrl = getAppUrl();
  const isTTY = process.stdin.isTTY ?? false;
  const config = readConfig();

  // No credentials provided → show current session status if already logged in.
  if (!opts.token && !opts.org && !opts.workspace) {
    const token = getToken();
    const orgSlug = getOrgId();
    const workspaceSlug = getWorkspaceId();
    if (token && orgSlug && workspaceSlug) {
      process.stdout.write(`Logged in to Oxagen:\n`);
      process.stdout.write(`  token:     ${maskToken(token)}\n`);
      process.stdout.write(`  org:       ${orgSlug}\n`);
      process.stdout.write(`  workspace: ${workspaceSlug}\n`);
      process.stdout.write(`  api:       ${apiUrl}\n`);
      process.stdout.write(`\nRun \`oxagen logout\` to clear the session.\n`);
      return;
    }
    // Fall through to auth flow if not logged in.
  }

  // ── Browser-based PKCE flow (default for interactive TTY) ───────────────────
  // Use browser flow when:
  //   - we are on an interactive TTY, AND
  //   - the caller has not provided a token directly (--token), AND
  //   - --no-browser has not been passed (opts.browser === false).
  const useBrowser = isTTY && !opts.token && opts.browser !== false;

  if (useBrowser) {
    try {
      const { browserLogin } = await import("../lib/loopback-login.js");
      const { token, orgSlug, workspaceSlug } = await browserLogin({ apiUrl, appUrl });
      writeConfig({ token, orgSlug, workspaceSlug, appUrl });
      process.stdout.write(`\nLogged in to Oxagen:\n`);
      process.stdout.write(`  token:     ${maskToken(token)}\n`);
      process.stdout.write(`  org:       ${orgSlug}\n`);
      process.stdout.write(`  workspace: ${workspaceSlug}\n`);
      process.stdout.write(`  api:       ${apiUrl}\n`);
    } catch (err) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  // ── Headless / token-paste flow (--token flag, --no-browser, or non-TTY) ────

  // ── Resolve token ────────────────────────────────────────────────────────────
  let token = opts.token ?? config.token;
  if (!token) {
    if (!isTTY) {
      process.stderr.write(
        `Error: No token provided. Pass --token <token> or run interactively.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `\nOxagen API token (create one at https://app.oxagen.sh/settings/tokens):\n`,
    );
    token = await promptLine("  Token: ");
  }
  if (!token) {
    process.stderr.write(`Error: Token cannot be empty.\n`);
    process.exitCode = 1;
    return;
  }

  // ── Resolve org slug ─────────────────────────────────────────────────────────
  let orgSlug = opts.org ?? config.orgSlug;
  if (!orgSlug) {
    if (!isTTY) {
      process.stderr.write(`Error: No org provided. Pass --org <slug>.\n`);
      process.exitCode = 1;
      return;
    }
    orgSlug = await promptLine("  Organization slug: ");
  }
  if (!orgSlug) {
    process.stderr.write(`Error: Organization slug cannot be empty.\n`);
    process.exitCode = 1;
    return;
  }

  // ── Resolve workspace slug ───────────────────────────────────────────────────
  let workspaceSlug = opts.workspace ?? config.workspaceSlug;
  if (!workspaceSlug) {
    if (!isTTY) {
      process.stderr.write(
        `Error: No workspace provided. Pass --workspace <slug>.\n`,
      );
      process.exitCode = 1;
      return;
    }
    workspaceSlug = await promptLine("  Workspace slug: ");
  }
  if (!workspaceSlug) {
    process.stderr.write(`Error: Workspace slug cannot be empty.\n`);
    process.exitCode = 1;
    return;
  }

  // ── Validate token against the platform ─────────────────────────────────────
  process.stdout.write(`\nAuthenticating against ${apiUrl}...\n`);
  const valid = await validatePlatformToken(token, apiUrl);
  if (!valid) {
    process.stderr.write(
      `Error: Token validation failed. Verify the token is a valid Oxagen API key.\n` +
        `  Get a token at: https://app.oxagen.sh/settings/tokens\n`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Persist session ──────────────────────────────────────────────────────────
  writeConfig({ token, orgSlug, workspaceSlug });

  process.stdout.write(`\nLogged in to Oxagen:\n`);
  process.stdout.write(`  token:     ${maskToken(token)}\n`);
  process.stdout.write(`  org:       ${orgSlug}\n`);
  process.stdout.write(`  workspace: ${workspaceSlug}\n`);
  process.stdout.write(`  api:       ${apiUrl}\n`);
}

export function handleLogout(): void {
  const config = readConfig();
  if (!config.token && !config.orgSlug && !config.workspaceSlug) {
    process.stdout.write(`Not logged in.\n`);
    return;
  }
  clearConfig();
  process.stdout.write(`Logged out. Session cleared from ~/.config/oxagen/config.json.\n`);
}
