import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  system: vi.fn(),
  tenant: vi.fn(),
  values: vi.fn(),
  rows: vi.fn(),
  predicate: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));
vi.mock("./run-outcomes-policy", () => ({
  assertRunOutcomesAllowed: mocks.guard,
}));
vi.mock("@oxagen/database", async (original) => {
  const actual = await original<typeof import("@oxagen/database")>();
  const tx = {
    insert: () => ({ values: mocks.values }),
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          mocks.predicate(where);
          return { for: mocks.rows };
        },
      }),
    }),
    delete: () => ({ where: mocks.remove }),
    update: () => ({ set: () => ({ where: mocks.update }) }),
  };
  const tenant = (fn: (value: unknown) => unknown) => {
    mocks.tenant();
    return fn(tx);
  };
  return {
    ...actual,
    withTenantDb: tenant,
    withOrgDb: tenant,
    withSystemDb: (fn: (value: unknown) => unknown) => {
      mocks.system();
      return fn(tx);
    },
  };
});
vi.mock("@oxagen/crypto", () => ({
  createIngestionCryptoAdapter: () => ({ adapter: {}, keyId: "test-key" }),
  resolveIngestionCryptoAdapterForKeyId: () => ({ adapter: {} }),
  encrypt: async (value: string) => Buffer.from(`encrypted:${value}`),
  decrypt: async (value: Buffer) =>
    Buffer.from(value.toString().replace(/^encrypted:/, "")),
}));
import {
  beginLinearAuthorization,
  completeLinearAuthorization,
  linearGraphql,
  resolveLinearIssueToken,
} from "./run-outcomes-linear";
import { z } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";
const scope = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const userId = "33333333-3333-4333-8333-333333333333";
let fetchMock: ReturnType<typeof vi.fn>;
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LINEAR_OAUTH_CLIENT_ID", "linear-client");
  vi.stubEnv("APP_URL", "https://app.oxagen.sh");
  mocks.guard.mockResolvedValue(undefined);
  mocks.values.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("native Linear OAuth", () => {
  it("stores one-time actor-bound state and advertises PKCE without a client secret", async () => {
    const result = await beginLinearAuthorization(scope, userId);
    const url = new URL(result.authorizeUrl);
    expect(url.origin).toBe("https://linear.app");
    expect(url.searchParams.get("scope")).toBe("read,issues:create");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("client_secret")).toBe(false);
    const state = mocks.values.mock.calls[0]?.[0];
    expect(JSON.parse(state.value)).toMatchObject({
      ...scope,
      userId,
      redirectUri: "https://app.oxagen.sh/api/run-outcomes/linear/callback",
    });
    expect(state.id).toBe(`run_linear_oauth:${url.searchParams.get("state")}`);
  });
  it("does not store state when deployment authorization is unconfigured", async () => {
    vi.stubEnv("LINEAR_OAUTH_CLIENT_ID", "");
    await expect(beginLinearAuthorization(scope, userId)).rejects.toMatchObject(
      { reason: "linear_oauth_not_configured" },
    );
    expect(mocks.values).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "bad json",
    JSON.stringify({
      ...scope,
      userId: scope.orgId,
      codeVerifier: "verifier",
      redirectUri: "https://app.oxagen.sh/api/run-outcomes/linear/callback",
    }),
  ])(
    "refuses expired, malformed or different-actor state before exchange",
    async (value) => {
      mocks.rows.mockResolvedValue(value === undefined ? [] : [{ value }]);
      await expect(
        completeLinearAuthorization(scope, userId, "a".repeat(43), "code"),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("consumes state and stores a new issue-only connection with encrypted credentials", async () => {
    mocks.rows.mockResolvedValue([
      {
        value: JSON.stringify({
          ...scope,
          userId,
          codeVerifier: "verifier",
          redirectUri: "https://app.oxagen.sh/api/run-outcomes/linear/callback",
        }),
      },
    ]);
    fetchMock
      .mockResolvedValueOnce(
        response({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 86400,
          scope: ["read", "issues:create"],
        }),
      )
      .mockResolvedValueOnce(
        response({
          data: {
            organization: { id: "linear-org", name: "Acme" },
            viewer: { id: "linear-user" },
          },
        }),
      );
    mocks.values
      .mockReturnValueOnce({
        returning: async () => [{ id: "connection-row", publicId: "con_new" }],
      })
      .mockResolvedValueOnce(undefined);
    expect(
      await completeLinearAuthorization(scope, userId, "a".repeat(43), "code"),
    ).toEqual({ connectionId: "con_new" });
    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.values.mock.calls[0]?.[0]).toMatchObject({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      connectorId: "linear",
      deliveryConfig: { runOutcomesOnly: true },
      deliveryMethod: "manual",
    });
    expect(mocks.values.mock.calls[1]?.[0].accessTokenEnc.ciphertext).not.toBe(
      "access",
    );
    expect(
      fetchMock.mock.calls.every((call) => call[1].redirect === "error"),
    ).toBe(true);
  });
  it("refuses a revoked policy between exchange and provider identity lookup", async () => {
    mocks.rows.mockResolvedValue([
      {
        value: JSON.stringify({
          ...scope,
          userId,
          codeVerifier: "v",
          redirectUri: "https://app.oxagen.sh/api/run-outcomes/linear/callback",
        }),
      },
    ]);
    fetchMock.mockImplementation(async () => {
      mocks.guard.mockRejectedValue(new Error("disabled"));
      return response({
        access_token: "a",
        refresh_token: "r",
        expires_in: 86400,
        scope: "read,issues:create",
      });
    });
    await expect(
      completeLinearAuthorization(scope, userId, "a".repeat(43), "code"),
    ).rejects.toThrow("disabled");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.values).not.toHaveBeenCalled();
  });
  it("treats GraphQL HTTP 200 errors as refusal", async () => {
    fetchMock.mockResolvedValue(
      response({ errors: [{ message: "denied" }], data: { ok: true } }),
    );
    await expect(
      linearGraphql(
        scope,
        "token",
        "query{}",
        {},
        z.object({ ok: z.boolean() }),
      ),
    ).rejects.toMatchObject({ reason: "linear_graphql_failed" });
  });
  it("does not expose credentials for unknown or read-only connections", async () => {
    mocks.rows.mockResolvedValueOnce([]);
    await expect(
      resolveLinearIssueToken(scope, "con_missing"),
    ).rejects.toMatchObject({ reason: "linear_connection_not_found" });
    mocks.rows
      .mockResolvedValueOnce([{ id: "row" }])
      .mockResolvedValueOnce([
        { scopes: ["read"], expiresAt: new Date(Date.now() + 3600000) },
      ]);
    await expect(
      resolveLinearIssueToken(scope, "con_read"),
    ).rejects.toMatchObject({ reason: "linear_issue_scope_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rotates expired tokens under the locked connection and token rows", async () => {
    mocks.rows.mockResolvedValueOnce([{ id: "row" }]).mockResolvedValueOnce([
      {
        scopes: ["read", "issues:create"],
        expiresAt: new Date(0),
        refreshTokenEnc: {
          keyId: "test-key",
          ciphertext: Buffer.from("encrypted:old-refresh").toString("base64"),
        },
      },
    ]);
    fetchMock.mockResolvedValue(
      response({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 86400,
        scope: "read,issues:create",
      }),
    );
    expect(await resolveLinearIssueToken(scope, "con_one")).toBe("new-access");
    expect(mocks.rows).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[1].body)).toContain(
      "refresh_token=old-refresh",
    );
  });
});

it("resolves only native issue connections under their workspace and organization", async () => {
  mocks.rows.mockResolvedValue([]);
  await expect(
    resolveLinearIssueToken(scope, "con_legacy"),
  ).rejects.toMatchObject({ reason: "linear_connection_not_found" });
  const query = new PgDialect().sqlToQuery(mocks.predicate.mock.calls[0]?.[0]);
  expect(query.sql).toContain("runOutcomesOnly");
  expect(query.params).toEqual(
    expect.arrayContaining([
      scope.orgId,
      scope.workspaceId,
      "con_legacy",
      "linear",
    ]),
  );
});
