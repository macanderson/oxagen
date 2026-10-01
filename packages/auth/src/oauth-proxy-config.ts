import { oAuthProxy } from "better-auth/plugins";
import type { BetterAuthPlugin } from "better-auth";

/**
 * OAuth Proxy configuration for multi-environment social login.
 *
 * A GitHub OAuth App (and a Google OAuth client) allows only ONE callback host.
 * A single login OAuth app is shared across production (app.oxagen.sh) and every
 * preview deployment, so a naive setup can satisfy only ONE host — the other
 * 403s with GitHub's "The redirect_uri is not associated with this application".
 *
 * Better Auth's oAuthProxy resolves this: the OAuth app is registered with the
 * PRODUCTION callback only. On production the proxy is a pure passthrough; on a
 * preview deployment it rewrites the outgoing redirect_uri to the production
 * callback and relays the authenticated session back to the preview origin
 * inside a payload encrypted with the shared secret.
 *
 * This module is the pure, unit-testable core of that wiring; auth.ts feeds it
 * the resolved environment values.
 */

/** Canonical production origin used when OAUTH_PROXY_PRODUCTION_URL is unset. */
export const DEFAULT_OAUTH_PROXY_PRODUCTION_URL = "https://app.oxagen.sh";

export interface OAuthProxyConfigInputs {
  /** True in local dev / test (and Vercel "development"); disables the proxy. */
  isLocalEnv: boolean;
  /** OAUTH_PROXY_PRODUCTION_URL, if set. */
  productionUrlEnv?: string | undefined;
  /** OAUTH_PROXY_SECRET (dedicated, shared across prod+preview), if set. */
  proxySecretEnv?: string | undefined;
  /** BETTER_AUTH_SECRET — fallback so the plugin can boot when no dedicated secret is set. */
  betterAuthSecret: string;
}

/**
 * Resolve the canonical production origin the shared social-login OAuth app's
 * callback is registered against. An explicit env override wins; otherwise the
 * production app URL. Trailing whitespace is trimmed (oAuthProxy itself strips a
 * trailing slash).
 */
export function resolveOAuthProxyProductionURL(
  productionUrlEnv?: string | undefined,
): string {
  const v = productionUrlEnv?.trim();
  return v ? v : DEFAULT_OAUTH_PROXY_PRODUCTION_URL;
}

/**
 * Resolve the OAuth-proxy relay secret. The dedicated OAUTH_PROXY_SECRET — which
 * MUST be identical across production and preview for the relay to decrypt — is
 * preferred. We fall back to BETTER_AUTH_SECRET only so the plugin can boot;
 * cross-environment relay then only works if the two share that secret.
 */
export function resolveOAuthProxySecret(
  proxySecretEnv: string | undefined,
  betterAuthSecret: string,
): string {
  const v = proxySecretEnv?.trim();
  return v ? v : betterAuthSecret;
}

/**
 * Build the OAuth-proxy plugin list.
 *
 * Empty in local dev: local uses a dedicated dev OAuth app with a localhost
 * callback, and proxying localhost through production would break local sign-in.
 * In deployed envs the proxy passes through on production and relays preview
 * social logins through the production callback.
 *
 * Returns the generic BetterAuthPlugin[] so the proxy endpoint's zod query
 * schema does not leak into the exported `auth` type (TS2883). We never call the
 * oauth-proxy endpoint from typed client code, so widening here is lossless.
 */
export function buildOAuthProxyPlugins(
  inputs: OAuthProxyConfigInputs,
): BetterAuthPlugin[] {
  if (inputs.isLocalEnv) return [];
  return [
    oAuthProxy({
      productionURL: resolveOAuthProxyProductionURL(inputs.productionUrlEnv),
      secret: resolveOAuthProxySecret(
        inputs.proxySecretEnv,
        inputs.betterAuthSecret,
      ),
    }),
  ];
}
