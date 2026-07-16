/**
 * Unit tests for assertGithubInstallationAccessible — the authorization gate that
 * stops a workspace binding an installationId it has no GitHub access to.
 *
 * Strategy: mock all I/O boundaries (withTenantDb for the oauth_accounts lookup,
 * @oxagen/crypto for token decryption, and global fetch for GET
 * /user/installations) so no real DB or network is touched. Each test drives one
 * branch: authorized, unauthorized, no token, undecryptable token, GitHub error,
 * and pagination.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  decrypt: vi.fn(),
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  schema: {
    oauthAccounts: {
      orgId: "oa.orgId",
      provider: "oa.provider",
      accessTokenEnc: "oa.accessTokenEnc",
      updatedAt: "oa.updatedAt",
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
    desc: (col: unknown) => ({ __desc: col }),
  };
});

vi.mock("@oxagen/crypto", () => ({
  decrypt: mocks.decrypt,
  resolveIngestionCryptoAdapterForKeyId: mocks.resolveIngestionCryptoAdapterForKeyId,
}));

import { assertGithubInstallationAccessible } from "../lib/github-installation-access";

const CTX = { orgId: "org-001", workspaceId: "ws-001" };
const ENC = { keyId: "ingestion:env:v1", ciphertext: "dG9rZW4=" };

/** A stored, decryptable GitHub OAuth token for the org. */
function mockHasToken(): void {
  mocks.withTenantDb.mockResolvedValueOnce([{ accessTokenEnc: ENC }]);
  mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValueOnce({ adapter: {} });
  mocks.decrypt.mockResolvedValueOnce(Buffer.from("ghu_user_token", "utf8"));
}

/** Stub global fetch to return the given /user/installations pages in order. */
function mockInstallationsPages(
  ...pages: Array<{ total_count: number; installations: Array<{ id: number | string }> }>
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const page of pages) {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => page });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("assertGithubInstallationAccessible", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves when the installation is in the user's /user/installations", async () => {
    mockHasToken();
    const fetchMock = mockInstallationsPages({
      total_count: 2,
      installations: [{ id: 111 }, { id: 9876 }],
    });

    await expect(assertGithubInstallationAccessible(CTX, "9876")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/installations?per_page=100&page=1",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer ghu_user_token" }) }),
    );
  });

  it("matches regardless of string/number id representation", async () => {
    mockHasToken();
    mockInstallationsPages({ total_count: 1, installations: [{ id: 9876 }] });
    // installationId supplied as a number; GitHub returns a number too.
    await expect(assertGithubInstallationAccessible(CTX, 9876)).resolves.toBeUndefined();
  });

  it("throws 403 when the installation is NOT reachable by the user", async () => {
    mockHasToken();
    mockInstallationsPages({ total_count: 1, installations: [{ id: 111 }] });

    await expect(assertGithubInstallationAccessible(CTX, "9876")).rejects.toThrow(
      "do not have access to GitHub installation 9876",
    );
  });

  it("throws 403 (fail-closed) when the workspace has no GitHub OAuth token", async () => {
    mocks.withTenantDb.mockResolvedValueOnce([]); // no oauth_accounts row
    const fetchMock = mockInstallationsPages(); // fetch must never be called

    await expect(assertGithubInstallationAccessible(CTX, "9876")).rejects.toThrow(
      "connect GitHub for this workspace first",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws 403 when the stored token cannot be decrypted", async () => {
    mocks.withTenantDb.mockResolvedValueOnce([{ accessTokenEnc: ENC }]);
    mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValueOnce({ adapter: {} });
    mocks.decrypt.mockRejectedValueOnce(new Error("bad key"));

    await expect(assertGithubInstallationAccessible(CTX, "9876")).rejects.toThrow(
      "stored GitHub token is unreadable",
    );
  });

  it("throws 403 (fail-closed) when GitHub returns a non-OK status (revoked token)", async () => {
    mockHasToken();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(assertGithubInstallationAccessible(CTX, "9876")).rejects.toThrow(
      "Could not verify GitHub installation access (GitHub returned 401)",
    );
  });

  it("paginates and finds the installation on a later page", async () => {
    mockHasToken();
    const page1 = {
      total_count: 150,
      installations: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })),
    };
    const page2 = {
      total_count: 150,
      installations: [{ id: 9876 }, ...Array.from({ length: 49 }, (_, i) => ({ id: i + 200 }))],
    };
    const fetchMock = mockInstallationsPages(page1, page2);

    await expect(assertGithubInstallationAccessible(CTX, "9876")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a 403 HTTPException (status carried) for the unauthorized case", async () => {
    mockHasToken();
    mockInstallationsPages({ total_count: 0, installations: [] });

    let status: number | undefined;
    try {
      await assertGithubInstallationAccessible(CTX, "9876");
    } catch (err) {
      status = (err as { status?: number }).status;
    }
    expect(status).toBe(403);
  });
});

describe("GitHub API call hygiene", () => {
  it("passes an abort/timeout signal to every /user/installations fetch (paged loop must not hang on a stalled page)", async () => {
    mockHasToken();
    const fetchMock = mockInstallationsPages(
      { total_count: 150, installations: Array.from({ length: 100 }, (_, i) => ({ id: i })) },
      { total_count: 150, installations: [{ id: 9876 }] },
    );

    await assertGithubInstallationAccessible(CTX, "9876");

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as { signal?: unknown };
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
