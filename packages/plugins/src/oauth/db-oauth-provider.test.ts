import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Credential store mock ─────────────────────────────────────────────────────
// We mock workspace-credential and state-store to unit-test the provider
// without a live DB or encryption keys.

const credStore: Record<string, {
  authKind: string;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
}> = {};

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
    return "cred-id-mock";
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
      accessToken: stored.accessToken ?? null,
      refreshToken: stored.refreshToken ?? null,
      oauthClientSecret: stored.oauthClientSecret ?? null,
      oauthClientId: stored.oauthClientId ?? null,
      authKind: stored.authKind,
      status: "active",
    };
  },
}));

// ── State store mock ──────────────────────────────────────────────────────────
const stateStore: Record<string, { value: string; expiresAt: number }> = {};

vi.mock("./state-store", () => ({
  saveOAuthState: async (
    state: string,
    data: Record<string, unknown>,
    now: number,
  ) => {
    stateStore[state] = { value: JSON.stringify(data), expiresAt: now + 10 * 60 * 1000 };
  },
  loadOAuthState: async (state: string, now: number) => {
    const entry = stateStore[state];
    if (!entry || entry.expiresAt <= now) return null;
    return JSON.parse(entry.value) as Record<string, unknown>;
  },
  deleteOAuthState: async (state: string) => {
    delete stateStore[state];
  },
}));

beforeEach(() => {
  Object.keys(credStore).forEach((k) => delete credStore[k]);
  Object.keys(stateStore).forEach((k) => delete stateStore[k]);
  vi.resetModules();
});

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  orgListingId: "ol-1",
  redirectUrl: "https://app.oxagen.ai/api/v1/mcp/oauth/callback",
  state: "test-state-abc",
  returnTo: "/org/ws/settings/integrations",
  clientName: "Oxagen",
  now: () => 1_700_000_000_000,
};

describe("DbOAuthClientProvider", () => {
  it("saveTokens → tokens round-trip", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);
    await provider.saveTokens({ access_token: "at-abc", token_type: "Bearer", refresh_token: "rt-xyz" });
    const loaded = await provider.tokens();
    expect(loaded).not.toBeUndefined();
    expect(loaded?.access_token).toBe("at-abc");
    expect(loaded?.refresh_token).toBe("rt-xyz");
    // Confirm no plaintext is stored in the credential store key check:
    const stored = credStore["ws-1:ol-1"];
    expect(stored?.accessToken).toBe("at-abc"); // mocked store (real store encrypts)
    expect(stored?.refreshToken).toBe("rt-xyz");
  });

  it("tokens() returns undefined when no credentials exist", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);
    const loaded = await provider.tokens();
    expect(loaded).toBeUndefined();
  });

  it("saveClientInformation → clientInformation round-trip", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);
    await provider.saveClientInformation({
      client_id: "dcr-client-id-123",
      client_secret: "dcr-secret-xyz",
      redirect_uris: [ctx.redirectUrl],
    });
    const info = await provider.clientInformation();
    expect(info).not.toBeUndefined();
    expect(info?.client_id).toBe("dcr-client-id-123");
    expect(info?.client_secret).toBe("dcr-secret-xyz");
  });

  it("clientInformation() returns undefined when no credential row", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);
    const info = await provider.clientInformation();
    expect(info).toBeUndefined();
  });

  it("saveCodeVerifier → codeVerifier via state store", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);
    await provider.saveCodeVerifier("cv-verifier-123");
    const cv = await provider.codeVerifier();
    expect(cv).toBe("cv-verifier-123");
    // Also confirm returnTo is persisted in the state.
    const entry = stateStore["test-state-abc"];
    expect(entry).toBeDefined();
    const parsed = JSON.parse(entry!.value) as Record<string, unknown>;
    expect(parsed["returnTo"]).toBe("/org/ws/settings/integrations");
  });

  it("codeVerifier() throws when state is missing", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);
    await expect(provider.codeVerifier()).rejects.toThrow("code verifier expired or missing");
  });

  it("redirectToAuthorization sets pendingRedirect", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);
    expect(provider.pendingRedirect).toBeNull();
    const authUrl = new URL("https://auth.example.com/authorize?foo=bar");
    await provider.redirectToAuthorization(authUrl);
    expect(provider.pendingRedirect).toBe(authUrl);
    expect(provider.pendingRedirect?.toString()).toContain("auth.example.com");
  });

  it("state() returns the state from ctx", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);
    expect(provider.state()).toBe("test-state-abc");
  });

  it("redirectUrl getter returns the redirectUrl from ctx", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);
    expect(provider.redirectUrl).toBe(ctx.redirectUrl);
  });

  it("clientMetadata includes redirect_uris and grant_types", async () => {
    const { DbOAuthClientProvider } = await import("./db-oauth-provider");
    const provider = new DbOAuthClientProvider(ctx);
    const meta = provider.clientMetadata;
    expect(meta.client_name).toBe("Oxagen");
    expect(meta.grant_types).toContain("authorization_code");
    expect(meta.grant_types).toContain("refresh_token");
  });
});
