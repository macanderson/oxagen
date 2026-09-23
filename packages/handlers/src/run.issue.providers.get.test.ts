import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  github: vi.fn(),
  urls: vi.fn(),
  rows: vi.fn(),
  token: vi.fn(),
  graphql: vi.fn(),
}));
vi.mock("./lib/capability-role-guard", () => ({
  assertCallerRole: mocks.role,
}));
vi.mock("./repository.github-connection", () => ({
  resolveWorkspaceGithubInstallation: mocks.github,
}));
vi.mock("./repository.main.get", () => ({
  envGithubUrls: { githubUrls: mocks.urls },
}));
vi.mock("@oxagen/plugins/run-outcomes-linear", () => ({
  linearOAuthConfigured: () => true,
  resolveLinearIssueToken: mocks.token,
  linearGraphql: mocks.graphql,
}));
vi.mock("@oxagen/database", async (original) => {
  const actual = await original<typeof import("@oxagen/database")>();
  const tenant = (fn: (tx: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => ({ innerJoin: () => ({ where: mocks.rows }) }),
      }),
    });
  return { ...actual, withTenantDb: tenant, withOrgDb: tenant };
});
import { handler } from "./run.issue.providers.get";
const ctx: CapabilityContext = {
  orgId: "org",
  workspaceId: "workspace",
  userId: "user",
  apiKeyId: null,
  surface: "api",
  messageId: null,
  requestId: "test-request",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.role.mockResolvedValue(undefined);
  mocks.github.mockResolvedValue(null);
  mocks.urls.mockReturnValue(null);
  mocks.rows.mockResolvedValue([
    { connectionId: "con_1", name: "Linear workspace" },
  ]);
});
describe("issue provider status", () => {
  it("reads recorded connections without provider requests or feature charges", async () => {
    const result = await handler({}, ctx);
    expect(result.github.connected).toBe(false);
    expect(result.linear.connections).toEqual([
      { connectionId: "con_1", name: "Linear workspace" },
    ]);
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
  it("keeps team pagination explicit and uses a scoped token", async () => {
    mocks.token.mockResolvedValue("secret");
    mocks.graphql.mockResolvedValue({
      teams: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "next" } },
    });
    const result = await handler(
      { linearConnectionId: "con_1", after: "prev" },
      ctx,
    );
    expect(mocks.token).toHaveBeenCalledWith(
      { orgId: "org", workspaceId: "workspace" },
      "con_1",
    );
    expect(result.linear).toMatchObject({
      hasNextPage: true,
      endCursor: "next",
    });
    expect(mocks.graphql.mock.calls[0]?.[3]).toEqual({ after: "prev" });
  });
  it("refuses unauthorized connection enumeration", async () => {
    mocks.role.mockRejectedValue(new Error("forbidden"));
    await expect(handler({}, ctx)).rejects.toThrow("forbidden");
    expect(mocks.rows).not.toHaveBeenCalled();
  });
});

it("lists native issue credentials without relabeling general ingestion connections", async () => {
  await handler({}, ctx);
  const query = new PgDialect().sqlToQuery(mocks.rows.mock.calls[0]?.[0]);
  expect(query.sql).toContain("runOutcomesOnly");
  expect(query.sql).toContain("scopes");
  expect(query.params).toEqual(
    expect.arrayContaining([ctx.orgId, ctx.workspaceId, "linear"]),
  );
});
