/**
 * Session helpers for the account-required gate (ADR-019 §4).
 *
 * The CLI requires an active Oxagen session (token + org + workspace) before
 * any agent-path command runs. Call `requireSession()` at the top of the
 * default action in index.ts; it exits 1 with a clear error if the session
 * is missing so the user knows exactly what to do next.
 */
import { getApiUrl, getOrgId, getToken, getWorkspaceId } from "./config.js";
import { resolveAiCredential } from "../agent/env.js";

export interface Session {
  token: string;
  orgSlug: string;
  workspaceSlug: string;
  apiUrl: string;
  /**
   * True when this is the synthetic benchmark session produced by
   * `OXAGEN_ALLOW_NO_SESSION=1` — there is no real account behind it. Run
   * paths must route model calls gateway-direct (`createGatewayAgentAi`)
   * instead of the platform port, and skip platform-bound side channels
   * (graph sync).
   */
  synthetic?: boolean;
}

/**
 * The synthetic benchmark session returned when `OXAGEN_ALLOW_NO_SESSION=1`.
 * Documented in `packages/config/src/registry.ts` (OXAGEN_ALLOW_NO_SESSION):
 * only for headless benchmark/CI sandboxes (bench/swe-bench,
 * bench/terminal-bench) that run the agent path with no logged-in account.
 */
function syntheticBenchSession(): Session {
  return {
    token: "",
    orgSlug: getOrgId() ?? "bench",
    workspaceSlug: getWorkspaceId() ?? "bench",
    apiUrl: getApiUrl(),
    synthetic: true,
  };
}

/** True when the account-required gate is explicitly bypassed for benchmarks. */
export function allowNoSession(): boolean {
  return process.env["OXAGEN_ALLOW_NO_SESSION"] === "1";
}

/** True when the user explicitly forces local BYOK even while logged in. */
export function forceLocalByok(): boolean {
  return process.env["OXAGEN_LOCAL"] === "1";
}

/**
 * A local BYOK session: no Oxagen account, model calls run locally with the
 * user's own key — `AI_GATEWAY_API_KEY` (gateway-direct, any model the gateway
 * supports; always wins when present) or `ANTHROPIC_API_KEY` (Anthropic API
 * direct, Anthropic models only). `synthetic: true` so the run paths route
 * through `createGatewayAgentAi` and skip platform-bound side channels,
 * exactly like the bench session.
 */
function localByokSession(): Session {
  return {
    token: "",
    orgSlug: "local",
    workspaceSlug: "local",
    apiUrl: getApiUrl(),
    synthetic: true,
  };
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

  // Explicit local BYOK (OXAGEN_LOCAL=1 / `--local`): use the user's own key
  // (gateway or Anthropic) even when logged in — the user wants their own
  // key/models, not the platform.
  if (forceLocalByok() && resolveAiCredential() !== null)
    return localByokSession();

  if (!token || !orgSlug || !workspaceSlug) {
    // Benchmark bypass (OXAGEN_ALLOW_NO_SESSION=1): headless bench containers
    // have no account; return the synthetic session instead of exiting. The
    // run paths detect `synthetic` and go gateway-direct for model calls.
    if (allowNoSession()) return syntheticBenchSession();

    // Local BYOK fallback: not logged in, but an AI key is available (shell
    // env, ~/.config/oxagen/config.json, or a nearby .env.local). Run locally
    // with the user's own key instead of exiting — AI_GATEWAY_API_KEY routes
    // gateway-direct (any vendor, always preferred); ANTHROPIC_API_KEY routes
    // straight to the Anthropic API (Anthropic models only). Explicit stderr
    // notice so this is never a silent auth bypass.
    const credential = resolveAiCredential();
    if (credential !== null) {
      const keyNote =
        credential.source === "gateway"
          ? "AI_GATEWAY_API_KEY"
          : "ANTHROPIC_API_KEY (Anthropic models only)";
      process.stderr.write(
        `Not logged in — running locally with ${keyNote} (BYOK). ` +
          "Run `oxagen login` to use your Oxagen account instead.\n",
      );
      return localByokSession();
    }

    const missing: string[] = [];
    if (!token) missing.push("token");
    if (!orgSlug) missing.push("org");
    if (!workspaceSlug) missing.push("workspace");

    process.stderr.write(
      `Not logged in (missing: ${missing.join(", ")}).\n` +
        "Run `oxagen login` to authenticate, or set AI_GATEWAY_API_KEY " +
        "(or ANTHROPIC_API_KEY for Anthropic models) to run locally (BYOK).\n",
    );
    process.exit(1);
  }

  return { token, orgSlug, workspaceSlug, apiUrl: getApiUrl() };
}
