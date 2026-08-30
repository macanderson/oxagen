/**
 * Unit tests for the OAuth Proxy configuration.
 *
 * These cover the multi-environment social-login wiring that avoids GitHub's
 * "The redirect_uri is not associated with this application" error when one
 * OAuth app is shared across production and preview deployments:
 *
 *   1. The proxy is DISABLED in local dev (so local uses its own dev OAuth app
 *      with a localhost callback, never relayed through production).
 *   2. The proxy is ENABLED in deployed envs as a single oAuthProxy plugin.
 *   3. productionURL resolves to OAUTH_PROXY_PRODUCTION_URL, else the canonical
 *      production app origin.
 *   4. The relay secret prefers the dedicated OAUTH_PROXY_SECRET and falls back
 *      to BETTER_AUTH_SECRET only when it is unset.
 */
import { describe, it, expect } from "vitest";
import {
  buildOAuthProxyPlugins,
  resolveOAuthProxyProductionURL,
  resolveOAuthProxySecret,
  DEFAULT_OAUTH_PROXY_PRODUCTION_URL,
} from "./oauth-proxy-config";

/** Narrow view of the oAuthProxy plugin's recorded options for assertions. */
type ProxyPluginShape = {
  id: string;
  options?: { productionURL?: string; secret?: string };
};

describe("resolveOAuthProxyProductionURL", () => {
  it("falls back to the canonical production origin when unset", () => {
    expect(resolveOAuthProxyProductionURL(undefined)).toBe(
      DEFAULT_OAUTH_PROXY_PRODUCTION_URL,
    );
    expect(DEFAULT_OAUTH_PROXY_PRODUCTION_URL).toBe("https://app.oxagen.sh");
  });

  it("falls back when given an empty or whitespace-only value", () => {
    expect(resolveOAuthProxyProductionURL("")).toBe(
      DEFAULT_OAUTH_PROXY_PRODUCTION_URL,
    );
    expect(resolveOAuthProxyProductionURL("   ")).toBe(
      DEFAULT_OAUTH_PROXY_PRODUCTION_URL,
    );
  });

  it("uses and trims an explicit override", () => {
    expect(resolveOAuthProxyProductionURL("https://app.example.com")).toBe(
      "https://app.example.com",
    );
    expect(resolveOAuthProxyProductionURL("  https://app.example.com  ")).toBe(
      "https://app.example.com",
    );
  });
});

describe("resolveOAuthProxySecret", () => {
  it("prefers the dedicated proxy secret", () => {
    expect(resolveOAuthProxySecret("dedicated-secret", "main-secret")).toBe(
      "dedicated-secret",
    );
    expect(resolveOAuthProxySecret("  dedicated-secret  ", "main-secret")).toBe(
      "dedicated-secret",
    );
  });

  it("falls back to BETTER_AUTH_SECRET when the dedicated secret is unset/blank", () => {
    expect(resolveOAuthProxySecret(undefined, "main-secret")).toBe(
      "main-secret",
    );
    expect(resolveOAuthProxySecret("", "main-secret")).toBe("main-secret");
    expect(resolveOAuthProxySecret("   ", "main-secret")).toBe("main-secret");
  });
});

describe("buildOAuthProxyPlugins", () => {
  it("is empty in local dev (proxy disabled)", () => {
    const plugins = buildOAuthProxyPlugins({
      isLocalEnv: true,
      productionUrlEnv: "https://app.oxagen.sh",
      proxySecretEnv: "shared",
      betterAuthSecret: "main",
    });
    expect(plugins).toEqual([]);
  });

  it("registers exactly one oAuthProxy plugin in deployed envs", () => {
    const plugins = buildOAuthProxyPlugins({
      isLocalEnv: false,
      productionUrlEnv: undefined,
      proxySecretEnv: undefined,
      betterAuthSecret: "main",
    });
    expect(plugins).toHaveLength(1);
    expect((plugins[0] as ProxyPluginShape).id).toBe("oauth-proxy");
  });

  it("threads the resolved productionURL and dedicated secret into the plugin", () => {
    const plugins = buildOAuthProxyPlugins({
      isLocalEnv: false,
      productionUrlEnv: "https://app.oxagen.sh",
      proxySecretEnv: "shared-proxy-secret",
      betterAuthSecret: "main-secret",
    });
    const opts = (plugins[0] as ProxyPluginShape).options;
    expect(opts?.productionURL).toBe("https://app.oxagen.sh");
    expect(opts?.secret).toBe("shared-proxy-secret");
  });

  it("uses the canonical production origin and the main secret when env is unset", () => {
    const plugins = buildOAuthProxyPlugins({
      isLocalEnv: false,
      productionUrlEnv: undefined,
      proxySecretEnv: undefined,
      betterAuthSecret: "main-secret",
    });
    const opts = (plugins[0] as ProxyPluginShape).options;
    expect(opts?.productionURL).toBe("https://app.oxagen.sh");
    expect(opts?.secret).toBe("main-secret");
  });
});
