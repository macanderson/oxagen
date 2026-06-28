/**
 * db-oauth-provider-branches.test.ts
 *
 * Targeted branch coverage for db-oauth-provider.ts lines 77-79:
 *   ...(cred.oauthClientSecret ? { client_secret: cred.oauthClientSecret } : {})
 *
 * The existing db-oauth-provider.test.ts tests clientInformation() when
 * oauthClientSecret IS set (truthy branch). This file covers the falsy branch —
 * when the credential row has a clientId but no clientSecret.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const credStore: Record<
  string,
  {
    authKind: string;
    oauthClientId: string | null;
    oauthClientSecret: string | null;
    accessToken: string | null;
    refreshToken: string | null;
  }
> = {};

vi.mock("../credentials/workspace-credential", () => ({
  setWorkspaceSecret: async (input: {
    orgId: string;
    workspaceId: string;
    orgListingId: string;
    authKind: string;
    oauthClientId?: string | null;
    oauthClientSecret?: string | null;
    accessToken?: string | null;
    refreshToken?: string | null;
  }) => {
    const key = `${input.workspaceId}:${input.orgListingId}`;
    credStore[key] = {
      authKind: input.authKind,
      oauthClientId: input.oauthClientId ?? null,
      oauthClientSecret: input.oauthClientSecret ?? null,
      accessToken: input.accessToken ?? null,
      refreshToken: input.refreshToken ?? null,
    };
    return "cred-id-branch";
  },
  getWorkspaceSecret: async (key: {
    orgId: string;
    workspaceId: string;
    orgListingId: string;
  }) => {
    const stored = credStore[`${key.workspaceId}:${key.orgListingId}`];
    if (!stored) return null;
    return {
      secret: null,
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      // No oauthClientSecret → null → triggers the {} branch in clientInformation()
      oauthClientSecret: stored.oauthClientSecret,
      oauthClientId: stored.oauthClientId,
      authKind: stored.authKind,
      status: "active",
    };
  },
}));

vi.mock("./state-store", () => ({
  saveOAuthState: vi.fn().mockResolvedValue(undefined),
  loadOAuthState: vi.fn().mockResolvedValue(null),
  deleteOAuthState: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  Object.keys(credStore).forEach((k) => delete credStore[k]);
  vi.resetModules();
});

const ctx = {
  orgId: "org-branch",
  workspaceId: "ws-branch",
  orgListingId: "ol-branch",
  redirectUrl: "https://app.oxagen.sh/api/v1/mcp/oauth/callback",
  state: "branch-state",
  returnTo: "/branch",
  clientName: "BranchTest",
  now: () => 1_700_000_000_000,
};

describe("DbOAuthClientProvider.clientInformation — branch coverage", () => {
  it("returns info WITHOUT client_secret when oauthClientSecret is null", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);

    // Save a client with id but NO secret → tests the {} falsy branch
    await provider.saveClientInformation({
      client_id: "dcr-id-no-secret",
      // client_secret intentionally omitted
      redirect_uris: [ctx.redirectUrl],
    });

    const info = await provider.clientInformation();

    expect(info).not.toBeUndefined();
    expect(info?.client_id).toBe("dcr-id-no-secret");
    // The {} branch: client_secret should NOT appear on the returned object
    expect("client_secret" in (info ?? {})).toBe(false);
  });

  it("returns info WITH client_secret when oauthClientSecret is set", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);

    await provider.saveClientInformation({
      client_id: "dcr-id-with-secret",
      client_secret: "dcr-secret-abc",
      redirect_uris: [ctx.redirectUrl],
    });

    const info = await provider.clientInformation();

    expect(info?.client_id).toBe("dcr-id-with-secret");
    expect(info?.client_secret).toBe("dcr-secret-abc");
  });
});
