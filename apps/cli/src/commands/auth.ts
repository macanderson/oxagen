/**
 * Auth commands: `oxagen login` and `oxagen logout`.
 *
 * Login default (interactive TTY, no --token): opens a browser-based PKCE
 * OAuth flow via `browserLogin` in auth/loopback-login.ts. The authorize page
 * lives at ${appUrl}/cli/authorize; the token exchange hits
 * POST ${apiUrl}/v1/auth/cli/token. On success, the returned
 * { token, orgSlug, workspaceSlug } is persisted to ~/.config/oxagen/config.json.
 *
 * Headless / CI fallback: pass --token (and optionally --org / --workspace) to
 * skip the browser entirely. If the flags are omitted but we are NOT on a TTY,
 * the command exits with an error. Pass --no-browser to force the token-prompt
 * flow even on an interactive TTY.
 *
 * Validation endpoint (token flow): GET /v1/auth/whoami
 *   - Requires a valid Bearer API key (auth middleware validates the key).
 *   - Returns 200 for a recognised key; 401 for an invalid or expired key.
 *   - Does not require an org/workspace path parameter — the API key itself
 *     carries the scope, so this works as a pure "is this key valid?" probe.
 */
import * as readline from "node:readline/promises";
import {
  getApiUrl,
  getAppUrl,
  getToken,
  readConfig,
  writeConfig,
  clearConfig,
} from "../lib/config.js";
import { resolveLinkedAccount } from "../lib/linker.js";

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
 * Outcome of probing a platform API token against the Oxagen API.
 *
 * - `valid`    — the key authenticated (HTTP 200). Fully usable.
 * - `forbidden`— the key authenticated but IAM denied the probe capability
 *                (HTTP 403). The key is REAL; API access is currently
 *                restricted for its principal/org.
 * - `invalid`  — the key was rejected by the auth layer (HTTP 401).
 * - `network`  — the request never reached the API (connection error).
 * - `unexpected` — any other HTTP status; we cannot conclude the key is valid.
 */
export type TokenProbe =
  | { kind: "valid" }
  | { kind: "forbidden" }
  | { kind: "invalid" }
  | { kind: "network"; detail: string }
  | { kind: "unexpected"; status: number };

/**
 * Probe a platform API token by calling GET /v1/auth/whoami — the auth-only
 * credential probe. Reaching the handler (200) proves the credential is valid;
 * the auth middleware returns 401 for an invalid one before the handler runs.
 * See the module header for the full status contract.
 */
export async function validatePlatformToken(
  token: string,
  apiUrl: string,
): Promise<TokenProbe> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/v1/auth/whoami`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return {
      kind: "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.ok) return { kind: "valid" };
  // 401 is the auth layer rejecting the key itself (missing/malformed/invalid/
  // expired). This is the only "not a valid key" signal.
  if (res.status === 401) return { kind: "invalid" };
  // 403 should not occur against whoami (no authz gate), but if any probe ever
  // returns it, the key still authenticated — treat it as a real key.
  if (res.status === 403) return { kind: "forbidden" };
  return { kind: "unexpected", status: res.status };
}

export interface InteractiveLoginResult {
  token: string;
  orgSlug: string;
  workspaceSlug: string;
}

/**
 * UI-agnostic core of the browser-based PKCE login flow: runs `browserLogin`
 * and persists the resulting session via `writeConfig` — the exact same
 * persistence path `oxagen login` uses. Shared by the one-shot CLI path
 * (`handleLogin` below) and the REPL's Ink-native `/login` panel (see
 * `repl/login-panel.tsx`), so there is exactly one implementation of "run
 * browser login and persist the session."
 *
 * `onStatus`/`signal` are passed straight through to `browserLogin` — see its
 * docs for why they exist (an Ink-mounted caller can't touch process.stdout,
 * and needs to be able to cancel a pending wait on Esc).
 */
export async function runBrowserLogin(
  onStatus?: (line: string) => void,
  signal?: AbortSignal,
): Promise<InteractiveLoginResult> {
  const apiUrl = getApiUrl();
  const appUrl = getAppUrl();
  const { browserLogin } = await import("../auth/loopback-login.js");
  const { token, orgSlug, workspaceSlug } = await browserLogin({
    apiUrl,
    appUrl,
    onStatus,
    signal,
  });
  writeConfig({ token, orgSlug, workspaceSlug, appUrl });
  return { token, orgSlug, workspaceSlug };
}

export async function handleLogin(opts: LoginOptions): Promise<void> {
  const apiUrl = getApiUrl();
  const appUrl = getAppUrl();
  const isTTY = process.stdin.isTTY ?? false;
  const config = readConfig();

  // No credentials provided → show current session status if already logged in.
  if (!opts.token && !opts.org && !opts.workspace) {
    const token = getToken();
    const orgSlug = config.orgSlug;
    const workspaceSlug = config.workspaceSlug;
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
      const { token, orgSlug, workspaceSlug } = await runBrowserLogin((line) =>
        process.stdout.write(`\n${line}\n`),
      );
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

  // ── Validate token against the platform ─────────────────────────────────────
  process.stdout.write(`\nAuthenticating against ${apiUrl}...\n`);
  const probe = await validatePlatformToken(token, apiUrl);

  switch (probe.kind) {
    case "invalid":
      process.stderr.write(
        `Error: Token validation failed. The API rejected this key (HTTP 401).\n` +
          `  Verify the token is a current, non-expired Oxagen API key.\n` +
          `  Get a token at: https://app.oxagen.sh/settings/tokens\n`,
      );
      process.exitCode = 1;
      return;
    case "network":
      process.stderr.write(
        `Error: Network error contacting ${apiUrl}: ${probe.detail}\n` +
          `  Check your connection and the --api / OXAGEN_API_URL setting.\n`,
      );
      process.exitCode = 1;
      return;
    case "unexpected":
      process.stderr.write(
        `Error: Unexpected response (HTTP ${probe.status}) from ${apiUrl}.\n` +
          `  Could not confirm the key is valid; not saving the session.\n`,
      );
      process.exitCode = 1;
      return;
    case "valid":
    case "forbidden":
      // Both mean the key is real (it authenticated). Persist the session.
      break;
  }

  // Persist the token before running the org/workspace picker so that
  // userApiPostOrThrow (called by the linker) can pick it up via getToken().
  writeConfig({ token });

  // ── Org + workspace picker via the shared linker ─────────────────────────────
  process.stdout.write(`\nFetching your organizations...\n`);
  let orgSlug: string;
  let workspaceSlug: string;
  try {
    const account = await resolveLinkedAccount({
      orgSlug: opts.org,
      workspaceSlug: opts.workspace,
      isTTY,
    });
    orgSlug = account.orgSlug;
    workspaceSlug = account.workspaceSlug;
  } catch (err) {
    // Picker failures must not leave a partial config (token but no scope).
    writeConfig({
      token: undefined,
      orgSlug: undefined,
      workspaceSlug: undefined,
    });
    // The token already validated — surface the real picker error rather than
    // a misleading "token invalid" message.
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Your token is valid, but selecting an org/workspace failed.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // ── Persist full session ─────────────────────────────────────────────────────
  // Persist appUrl alongside the session so getAppUrl() resolves it later, the
  // same way the browser flow's runBrowserLogin() does — otherwise the token
  // path would silently drop the resolved app URL.
  writeConfig({ token, orgSlug, workspaceSlug, appUrl });

  process.stdout.write(`\nLogged in to Oxagen:\n`);
  process.stdout.write(`  token:     ${maskToken(token)}\n`);
  process.stdout.write(`  org:       ${orgSlug}\n`);
  process.stdout.write(`  workspace: ${workspaceSlug}\n`);
  process.stdout.write(`  api:       ${apiUrl}\n`);

  if (probe.kind === "forbidden") {
    process.stderr.write(
      `\nNote: this key authenticated, but the API currently denies it access ` +
        `(HTTP 403).\n` +
        `  Capability calls for org "${orgSlug}" may be blocked until the org's ` +
        `API-key access is enabled.\n`,
    );
  }
}

export function handleLogout(): void {
  const config = readConfig();
  if (!config.token && !config.orgSlug && !config.workspaceSlug) {
    process.stdout.write(`Not logged in.\n`);
    return;
  }
  clearConfig();
  process.stdout.write(
    `Logged out. Session cleared from ~/.config/oxagen/config.json.\n` +
      `Note: per-project links (.oxagen/workspace.json) are left intact.\n`,
  );
}
