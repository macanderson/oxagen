/**
 * Unit tests for resolveGitHubToken (ADR-020).
 *
 * Strategy: mock all I/O boundaries (withTenantDb, getInstallationToken,
 * resolveIngestionCryptoAdapterForKeyId, decrypt) so no real DB or network
 * calls are made. Each test exercises exactly one branch of the resolution chain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that import the subject.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  getInstallationToken: vi.fn(),
  decrypt: vi.fn(),
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  schema: {
    sourceConnections: {
      orgId: "sc.orgId",
      workspaceId: "sc.workspaceId",
      connectorId: "sc.connectorId",
      status: "sc.status",
      deletedAt: "sc.deletedAt",
      oauthAccountId: "sc.oauthAccountId",
      deliveryConfig: "sc.deliveryConfig",
    },
    oauthAccounts: {
      id: "oa.id",
      accessTokenEnc: "oa.accessTokenEnc",
    },
  },
  withTenantDb: mocks.withTenantDb,
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...real,
    and: (...args: unknown[]) => ({ __and: args }),
    eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
    isNull: (col: unknown) => ({ __isNull: col }),
  };
});

vi.mock("@oxagen/github", () => ({
  getInstallationToken: mocks.getInstallationToken,
}));

vi.mock("@oxagen/crypto", () => ({
  decrypt: mocks.decrypt,
  resolveIngestionCryptoAdapterForKeyId:
    mocks.resolveIngestionCryptoAdapterForKeyId,
}));

// ---------------------------------------------------------------------------
// Import subject *after* mocks are registered.
// ---------------------------------------------------------------------------

import { resolveGitHubToken } from "../lib/github-token";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

import type { CapabilityContext } from "@oxagen/oxagen";

function makeCtx(
  overrides: Partial<CapabilityContext> = {},
): CapabilityContext {
  return {
    orgId: "org-001",
    workspaceId: "ws-001",
    userId: null,
    apiKeyId: null,
    requestId: "req-001",
    surface: "api",
    messageId: null,
    ...overrides,
  };
}

/** Build a mock withTenantDb that returns rows on successive calls. */
function mockDbCalls(...callResults: unknown[][]): void {
  for (const rows of callResults) {
    mocks.withTenantDb.mockResolvedValueOnce(rows);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// GitHub credentials this suite reasons about. Each test opts into the env it
// needs via vi.stubEnv; the baseline must be "none present". A developer's
// shell exports these from .env.local (GITHUB_APP_ID / _PRIVATE_KEY /
// GITHUB_PERSONAL_ACCESS_TOKEN), and vi.unstubAllEnvs() restores that ambient
// state — so without an explicit clear they leak into Path 1 (App token) and
// Path 3 (PAT fallback) and break the "no credentials" assertions. CI doesn't
// export them, so this only bit local runs.
const GITHUB_CRED_ENV = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
] as const;

describe("resolveGitHubToken", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const key of GITHUB_CRED_ENV) delete process.env[key];
    // Hermetic env: resolveGitHubToken reads GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY
    // (Path 1) and GITHUB_PERSONAL_ACCESS_TOKEN (Path 3) straight from process.env.
    // vi.unstubAllEnvs() only clears vi stubs, NOT vars inherited from the shell, so
    // a developer with these exported locally would otherwise see Path 1/3 fire in
    // tests that assume them absent. Neutralize them here (empty string is falsy for
    // every check); per-test stubs that set real values still override these.
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("GITHUB_PERSONAL_ACCESS_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of GITHUB_CRED_ENV) delete process.env[key];
  });

  // ── Path 1: GitHub App installation token ──────────────────────────────

  it("returns installation token when installationId + App keys are present", async () => {
    vi.stubEnv("GITHUB_APP_ID", "12345");
    vi.stubEnv(
      "GITHUB_APP_PRIVATE_KEY",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
    );

    mockDbCalls([
      {
        oauthAccountId: null,
        deliveryConfig: { installationId: 9876, owner: "acme", repo: "mono" },
      },
    ]);

    mocks.getInstallationToken.mockResolvedValueOnce({
      token: "ghs_installation_token",
      expiresAt: Date.now() + 3_600_000,
    });

    const token = await resolveGitHubToken(makeCtx());

    expect(token).toBe("ghs_installation_token");
    expect(mocks.getInstallationToken).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "12345",
        installationId: 9876,
      }),
    );
  });

  it("prefers installation token over OAuth token when both are available", async () => {
    vi.stubEnv("GITHUB_APP_ID", "777");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "pk");

    mockDbCalls([
      {
        oauthAccountId: "oauth-acc-uuid",
        deliveryConfig: { installationId: 111 },
      },
    ]);

    mocks.getInstallationToken.mockResolvedValueOnce({
      token: "ghs_preferred",
      expiresAt: Date.now() + 3_600_000,
    });

    const token = await resolveGitHubToken(makeCtx());

    expect(token).toBe("ghs_preferred");
    // OAuth path (withTenantDb called a second time for oauthAccounts) must NOT run.
    expect(mocks.withTenantDb).toHaveBeenCalledOnce();
  });

  it("falls through to OAuth when installationId is missing even with App keys", async () => {
    vi.stubEnv("GITHUB_APP_ID", "777");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "pk");

    const encryptedPayload = {
      keyId: "ingestion:env:v1",
      ciphertext: "Y2lwaGVydGV4dA==",
    };
    mockDbCalls(
      // connection row — no installationId
      [{ oauthAccountId: "oauth-uuid", deliveryConfig: { owner: "acme" } }],
      // oauth_accounts row
      [{ accessTokenEnc: encryptedPayload }],
    );

    const fakeAdapter = {};
    mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValueOnce({
      adapter: fakeAdapter,
    });
    mocks.decrypt.mockResolvedValueOnce(Buffer.from("ghp_oauth_token", "utf8"));

    const token = await resolveGitHubToken(makeCtx());

    expect(token).toBe("ghp_oauth_token");
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
  });

  // ── Path 2: stored per-workspace OAuth token ───────────────────────────

  it("decrypts and returns the OAuth token when no App keys are set", async () => {
    const encryptedPayload = {
      keyId: "ingestion:env:v1",
      ciphertext: "dG9rZW5ieXRlcw==",
    };

    mockDbCalls(
      [
        {
          oauthAccountId: "acc-uuid-123",
          deliveryConfig: { installationId: 55 },
        },
      ],
      [{ accessTokenEnc: encryptedPayload }],
    );

    const fakeAdapter = { decryptDataKey: vi.fn() };
    mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValueOnce({
      adapter: fakeAdapter,
    });
    mocks.decrypt.mockResolvedValueOnce(
      Buffer.from("ghp_decrypted_oauth", "utf8"),
    );

    const token = await resolveGitHubToken(makeCtx());

    expect(token).toBe("ghp_decrypted_oauth");
    // The adapter must be routed by the envelope's STORED keyId, not the global
    // INGESTION_CRYPTO_PROVIDER — this is the cross-provider regression guard.
    expect(mocks.resolveIngestionCryptoAdapterForKeyId).toHaveBeenCalledWith(
      encryptedPayload.keyId,
    );
    expect(mocks.decrypt).toHaveBeenCalledWith(
      expect.any(Buffer), // Buffer.from(enc.ciphertext, "base64")
      encryptedPayload.keyId,
      { adapter: fakeAdapter },
    );
    expect(mocks.getInstallationToken).not.toHaveBeenCalled();
  });

  it("falls through to env when the connection has no oauthAccountId", async () => {
    vi.stubEnv("GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_env_fallback");

    mockDbCalls([{ oauthAccountId: null, deliveryConfig: null }]);

    const token = await resolveGitHubToken(makeCtx());

    expect(token).toBe("ghp_env_fallback");
    expect(mocks.withTenantDb).toHaveBeenCalledOnce(); // only connection query
  });

  // ── Path 3: env-var fallback ────────────────────────────────────────────

  it("returns GITHUB_PERSONAL_ACCESS_TOKEN when no workspace connection exists", async () => {
    vi.stubEnv("GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_personal_token");

    // No connection rows.
    mockDbCalls([]);

    const token = await resolveGitHubToken(makeCtx());

    expect(token).toBe("ghp_personal_token");
    expect(mocks.withTenantDb).toHaveBeenCalledOnce();
  });

  // ── Path 3 production guard: PAT must not be set in prod ─────────────────

  it("warns loudly (but still returns the token) when the PAT is used in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_prod_leak");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // No connection rows → resolution falls to the env-var fallback.
    mockDbCalls([]);

    const token = await resolveGitHubToken(makeCtx());

    expect(token).toBe("ghp_prod_leak");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "GITHUB_PERSONAL_ACCESS_TOKEN is set in production",
      ),
    );

    warnSpy.mockRestore();
  });

  it("stays quiet in development when the PAT is used as a fallback", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_dev_ok");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockDbCalls([]);

    const token = await resolveGitHubToken(makeCtx());

    expect(token).toBe("ghp_dev_ok");
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  // ── Path 4: error ───────────────────────────────────────────────────────

  it("throws an actionable error when no credentials are available", async () => {
    mockDbCalls([]);

    await expect(resolveGitHubToken(makeCtx())).rejects.toThrow(
      "No GitHub connection for this workspace",
    );
  });

  it("throws even when a connection exists but no installationId, no oauthAccountId, and no env token", async () => {
    mockDbCalls([{ oauthAccountId: null, deliveryConfig: null }]);

    await expect(resolveGitHubToken(makeCtx())).rejects.toThrow(
      "connect GitHub in Settings",
    );
  });
});
