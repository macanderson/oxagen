// The one implementation of "what can this workspace's GitHub authorization
// reach" — the token it asks with, the paging it walks, and the fail-closed
// throw that keeps "we could not ask" from reading as "there is nothing there".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  decrypt: vi.fn(),
  resolveIngestionCryptoAdapterForKeyId: vi.fn(),
}));

vi.mock("@oxagen/database", () => {
  const dbMock = {
    schema: {
      oauthAccounts: {
        orgId: "oa.orgId",
        provider: "oa.provider",
        accessTokenEnc: "oa.accessTokenEnc",
        updatedAt: "oa.updatedAt",
      },
    },
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

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
  resolveIngestionCryptoAdapterForKeyId:
    mocks.resolveIngestionCryptoAdapterForKeyId,
}));

import {
  GithubUserInstallationsError,
  githubUserInstallationsDeps,
  listUserGithubInstallations,
  resolveWorkspaceGithubUserToken,
} from "./repository.github-user-installations";

const SCOPE = { orgId: "org-001", workspaceId: "ws-001" };
const ENC = { keyId: "ingestion:env:v1", ciphertext: "dG9rZW4=" };

/** A stored, decryptable GitHub OAuth token for the org. */
function storedToken(token = "ghu_user_token"): void {
  mocks.withTenantDb.mockResolvedValueOnce([{ accessTokenEnc: ENC }]);
  mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValueOnce({
    adapter: {},
  });
  mocks.decrypt.mockResolvedValueOnce(Buffer.from(token, "utf8"));
}

/** Stub global fetch with the given /user/installations pages, in order. */
function pages(
  ...bodies: Array<{ total_count: number; installations: unknown[] }>
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveWorkspaceGithubUserToken", () => {
  it("decrypts the org's most-recently-refreshed GitHub authorization", async () => {
    storedToken();
    await expect(resolveWorkspaceGithubUserToken(SCOPE)).resolves.toEqual({
      ok: true,
      accessToken: "ghu_user_token",
    });
    // Routed by the envelope's own keyId, not the runtime's current provider:
    // the token may have been wrapped under a different one.
    expect(mocks.resolveIngestionCryptoAdapterForKeyId).toHaveBeenCalledWith(
      ENC.keyId,
    );
  });

  // The two failures have different next clicks — connect GitHub, or reconnect
  // it — so they stay distinguishable rather than collapsing into one null.
  it("names a missing authorization and an unreadable one apart (negative)", async () => {
    mocks.withTenantDb.mockResolvedValueOnce([]);
    await expect(resolveWorkspaceGithubUserToken(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "no_account",
    });

    mocks.withTenantDb.mockResolvedValueOnce([{ accessTokenEnc: ENC }]);
    mocks.resolveIngestionCryptoAdapterForKeyId.mockReturnValueOnce({
      adapter: {},
    });
    mocks.decrypt.mockRejectedValueOnce(new Error("bad key"));
    await expect(resolveWorkspaceGithubUserToken(SCOPE)).resolves.toEqual({
      ok: false,
      reason: "unreadable",
    });
  });
});

describe("listUserGithubInstallations", () => {
  it("asks GitHub as the user and projects every fact the surfaces cite", async () => {
    const fetchMock = pages({
      total_count: 1,
      installations: [
        {
          id: 555,
          account: {
            login: "acme",
            type: "Organization",
            avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
          },
          repository_selection: "selected",
        },
      ],
    });

    await expect(
      listUserGithubInstallations("ghu_user_token"),
    ).resolves.toEqual([
      {
        installationId: "555",
        accountLogin: "acme",
        accountType: "Organization",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        repositorySelection: "selected",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user/installations?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghu_user_token",
        }),
      }),
    );
  });

  it("carries every optional fact as null rather than dropping the row", async () => {
    pages({ total_count: 1, installations: [{ id: "777" }] });
    await expect(
      listUserGithubInstallations("ghu_user_token"),
    ).resolves.toEqual([
      {
        installationId: "777",
        accountLogin: null,
        accountType: null,
        avatarUrl: null,
        repositorySelection: null,
      },
    ]);
  });

  it("pages until GitHub runs out of rows", async () => {
    const fetchMock = pages(
      {
        total_count: 150,
        installations: Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          account: { login: `a${i}` },
        })),
      },
      {
        total_count: 150,
        installations: Array.from({ length: 50 }, (_, i) => ({
          id: i + 200,
          account: { login: `b${i}` },
        })),
      },
    );
    const all = await listUserGithubInstallations("ghu_user_token");
    expect(all).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // `total_count` is upstream-controlled and need not match the rows returned —
  // GitHub filters suspended installations out of the rows and not out of the
  // count — so a short page ends the walk rather than leaving it unreachable.
  it("stops on a short page even though total_count is higher (negative)", async () => {
    const fetchMock = pages(
      {
        total_count: 999,
        installations: Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          account: { login: `a${i}` },
        })),
      },
      { total_count: 999, installations: [] },
    );
    await expect(
      listUserGithubInstallations("ghu_user_token"),
    ).resolves.toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Fail closed. "We could not ask" must never reach a caller as "there is
  // nothing there": one of those means install the App, the other does not.
  it("throws with the status rather than answering an empty list (negative)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({ ok: false, status: 401 }),
    );
    const err = await listUserGithubInstallations("revoked").catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GithubUserInstallationsError);
    expect((err as GithubUserInstallationsError).status).toBe(401);
  });
});

describe("githubUserInstallationsDeps", () => {
  it("answers null when there is no token, without calling GitHub (negative)", async () => {
    mocks.withTenantDb.mockResolvedValueOnce([]);
    const fetchMock = pages();
    await expect(githubUserInstallationsDeps.candidates(SCOPE)).resolves.toBe(
      null,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks GitHub with the workspace's own token when there is one", async () => {
    storedToken("ghu_stored");
    const fetchMock = pages({ total_count: 0, installations: [] });
    await expect(
      githubUserInstallationsDeps.candidates(SCOPE),
    ).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/user/installations"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ghu_stored" }),
      }),
    );
  });
});
