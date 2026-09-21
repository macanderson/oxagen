import { afterEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  mint: vi.fn(),
  decrypt: vi.fn(),
  adapter: {},
  queries: [] as unknown[],
  rows: [] as unknown[][],
}));
vi.mock("@oxagen/github", () => ({ getInstallationToken: mocks.mint }));
vi.mock("@oxagen/crypto", () => ({
  decrypt: mocks.decrypt,
  resolveIngestionCryptoAdapterForKeyId: () => ({ adapter: mocks.adapter }),
}));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      select: () => ({
        from: () => ({
          where: (predicate: unknown) => {
            mocks.queries.push(predicate);
            return { limit: async () => mocks.rows.shift() ?? [] };
          },
        }),
      }),
    }),
}));
import { resolveGitHubToken } from "./workspace-token";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.queries.length = 0;
  mocks.rows.length = 0;
});

describe("workspace GitHub credentials", () => {
  it("falls back after mint failure and scopes decrypted OAuth credentials to the organization", async () => {
    vi.stubEnv("GITHUB_APP_ID", "1");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "test-key");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.mint.mockRejectedValueOnce(new Error("mint failed"));
    mocks.decrypt.mockResolvedValueOnce(Buffer.from("oauth-token"));
    mocks.rows.push(
      [{ oauthAccountId: "account-1", deliveryConfig: { installationId: 7 } }],
      [
        {
          accessTokenEnc: {
            keyId: "old-key",
            ciphertext: Buffer.from("ciphertext").toString("base64"),
          },
        },
      ],
    );
    await expect(
      resolveGitHubToken({ orgId: "org-1", workspaceId: "ws-1" }),
    ).resolves.toBe("oauth-token");
    const query = new PgDialect().sqlToQuery(mocks.queries[1] as SQL);
    expect(query.sql).toContain('"org_id" =');
    expect(query.params).toEqual(["account-1", "org-1"]);
    expect(mocks.decrypt).toHaveBeenCalledWith(
      Buffer.from("ciphertext"),
      "old-key",
      { adapter: mocks.adapter },
    );
    const connection = new PgDialect().sqlToQuery(mocks.queries[0] as SQL);
    expect(connection.params).toContain("ws-1");
  });
});

it("uses the approved connection id and refuses a shared fallback when it has no credential", async () => {
  vi.stubEnv("GITHUB_PERSONAL_ACCESS_TOKEN", "unrelated-shared-token");
  mocks.rows.push([]);
  await expect(
    resolveGitHubToken({
      orgId: "org-1",
      workspaceId: "ws-1",
      connectionId: "approved-connection",
    }),
  ).rejects.toThrow("approved repository connection");
  const query = new PgDialect().sqlToQuery(mocks.queries[0] as SQL);
  expect(query.sql).toContain('"source_connections"."id" =');
  expect(query.params).toContain("approved-connection");
  expect(query.params).toContain("org-1");
  expect(query.params).toContain("ws-1");
});
