/**
 * Auth commands: `oxagen login` and `oxagen logout`.
 *
 * Login validates a platform API key against the Oxagen API and persists the
 * session (token + orgSlug + workspaceSlug) to ~/.config/oxagen/config.json.
 *
 * Validation endpoint: GET /v1/user/preferences/read
 *   - The auth middleware resolves the Bearer API key BEFORE any IAM check.
 *   - 401 (unauthorized) is the ONLY signal that the key itself is not valid:
 *     "Missing credentials" / "Malformed API key" / "Invalid API key" /
 *     "API key expired" all surface as 401. Treat 401 (and only 401) as an
 *     invalid key.
 *   - 200 means the key is valid AND the caller may read preferences.
 *   - 403 (forbidden) means the key IS valid (it authenticated past the auth
 *     middleware) but the IAM resolver denied this one capability for the key's
 *     principal — e.g. enterprise orgs currently fail-closed on API-key callers
 *     until keys are linked to service principals. A 403 therefore PROVES the
 *     key is real; the login probe must NOT reject it. We persist the session
 *     and warn that API access is currently restricted.
 *   - Any other status (404/5xx/etc.) is treated as an unexpected/inconclusive
 *     response so the user is not silently logged in against a broken endpoint.
 *
 * The earlier implementation returned `res.ok`, which conflated 403 with a bad
 * key: a perfectly valid key whose org IAM-denies the probe capability was
 * reported as "Token validation failed". Distinguishing the auth layer (401)
 * from the authz layer (403) fixes that.
 *
 * BYOK AI removal (AI_GATEWAY_API_KEY → platform-routed AI) is deferred to
 * ADR-019 task B4. This command establishes the session + account-required
 * gate; the AI transport stays BYOK for now.
 */
import * as readline from "node:readline/promises";
import {
  getApiUrl,
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
 * Probe a platform API token by calling GET /v1/user/preferences/read.
 *
 * Distinguishes the auth layer (401 → invalid key) from the authz layer
 * (403 → valid key, capability denied). See the module header for the full
 * status contract.
 */
export async function validatePlatformToken(
  token: string,
  apiUrl: string,
): Promise<TokenProbe> {
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
    return {
      kind: "network",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.ok) return { kind: "valid" };
  // 403 means the key got PAST the auth middleware — it is a real, recognised
  // key — but the IAM resolver denied this capability. The key is valid.
  if (res.status === 403) return { kind: "forbidden" };
  // 401 is the auth layer rejecting the key itself (missing/malformed/invalid/
  // expired). This is the only "not a valid key" signal.
  if (res.status === 401) return { kind: "invalid" };
  return { kind: "unexpected", status: res.status };
}

export async function handleLogin(opts: LoginOptions): Promise<void> {
  const apiUrl = getApiUrl();
  const isTTY = process.stdin.isTTY ?? false;
  const config = readConfig();

  // No flags → show current session status if logged in.
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
    // Fall through to interactive auth flow if not logged in.
  }

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
      `\nOxagen API token (create one at https://app.oxagen.sh):\n`,
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
  const probe = await validatePlatformToken(token, apiUrl);

  switch (probe.kind) {
    case "invalid":
      process.stderr.write(
        `Error: Token validation failed. The API rejected this key (HTTP 401).\n` +
          `  Verify the token is a current, non-expired Oxagen API key.\n` +
          `  Get a token at: https://app.oxagen.sh\n`,
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

  // ── Persist session ──────────────────────────────────────────────────────────
  writeConfig({ token, orgSlug, workspaceSlug });

  process.stdout.write(`\nLogged in to Oxagen:\n`);
  process.stdout.write(`  token:     ${maskToken(token)}\n`);
  process.stdout.write(`  org:       ${orgSlug}\n`);
  process.stdout.write(`  workspace: ${workspaceSlug}\n`);
  process.stdout.write(`  api:       ${apiUrl}\n`);

  if (probe.kind === "forbidden") {
    // The key authenticated but IAM denied the probe capability. Tell the user
    // their session is saved while being honest that API calls may be blocked.
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
  process.stdout.write(`Logged out. Session cleared from ~/.config/oxagen/config.json.\n`);
}
