import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeQuery } from "./test-query";

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
});
vi.mock("next/navigation", () => ({ redirect }));

const query = {
  orgUsers: { findMany: vi.fn() },
  workspaceUsers: { findMany: vi.fn() },
  organizations: { findMany: vi.fn(), findFirst: vi.fn() },
  workspaces: { findMany: vi.fn(), findFirst: vi.fn() },
  sourceConnections: { findMany: vi.fn() },
};
const filters: string[] = [];
const recording = new Proxy(query, {
  get: (target, table: string) =>
    new Proxy(target[table as keyof typeof query], {
      get:
        (methods, method: string) =>
        (options: Parameters<typeof describeQuery>[0]) => {
          const d = describeQuery(options);
          filters.push(
            `${table}.${method} ${d.where ?? ""} ${d.orderBy ?? ""}`.trim(),
          );
          return (methods as Record<string, (o: unknown) => unknown>)[method]?.(
            options,
          );
        },
    }),
});
vi.mock("@oxagen/database", () => ({
  withSystemDb: (fn: (tx: unknown) => unknown) => fn({ query: recording }),
}));

const getAuthUser = vi.fn();
vi.mock("./session", () => ({ getAuthUser }));
const actorCanManageApiKeys = vi.fn();
vi.mock("@oxagen/handlers", () => ({ actorCanManageApiKeys }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_s: unknown, fn: () => unknown) => fn(),
}));
const createCliAuthCode = vi.fn();
vi.mock("@oxagen/auth/cli-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/auth/cli-auth")>()),
  generateCliAuthCode: () => "code_123",
  createCliAuthCode,
}));
const warn = vi.fn();
vi.mock("@oxagen/handlers/logger", () => ({ logger: { warn } }));

const cli = await import("./cli-authorize");
const { approveCliAuth, cancelCliAuth } = await import("./cli-actions");
const github = await import("./github-setup");
const { githubSetupQueries } = await import("./github-setup-queries");

const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const valid = {
  redirect_uri: "http://127.0.0.1:53682/callback",
  state: "st_1",
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
};

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
function fixtureMode() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MC_DATA", "fixture");
}
function liveMode() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MC_DATA", "live");
}

beforeEach(() => {
  filters.length = 0;
  for (const table of Object.values(query))
    for (const fn of Object.values(table)) fn.mockReset();
  getAuthUser.mockReset();
  actorCanManageApiKeys.mockReset();
  createCliAuthCode.mockReset();
  redirect.mockClear();
  warn.mockReset();
});

describe("CLI authorize parameters", () => {
  it("reads and defaults the label", () => {
    expect(
      cli.readAuthorizeParams({ ...valid, label: ["  my-laptop  ", "x"] })
        .label,
    ).toBe("my-laptop");
    expect(cli.readAuthorizeParams({}).label).toBe("Oxagen CLI");
  });

  it("accepts a loopback S256 request", () => {
    expect(cli.authorizeParamErrors(cli.readAuthorizeParams(valid))).toEqual(
      [],
    );
  });

  it("names every invalid parameter, and never accepts a non-loopback redirect", () => {
    expect(
      cli.authorizeParamErrors(
        cli.readAuthorizeParams({
          redirect_uri: "https://evil.example/cb",
          code_challenge: "short",
          code_challenge_method: "plain",
        }),
      ),
    ).toEqual(["redirectUri", "codeChallenge", "codeChallengeMethod", "state"]);
  });

  it("builds the return path log in sends the person back to", () => {
    const path = cli.authorizeReturnPath(cli.readAuthorizeParams(valid));
    expect(path.startsWith("/cli/authorize?")).toBe(true);
    expect(new URLSearchParams(path.split("?")[1]).get("redirect_uri")).toBe(
      valid.redirect_uri,
    );
  });

  it("groups memberships, dropping workspaces of other orgs and orgs with no workspace", () => {
    expect(
      cli.groupScopes(
        [
          { id: "o1", slug: "acme", name: "Acme" },
          { id: "o2", slug: "empty", name: "Empty" },
        ],
        [
          { id: "w1", slug: "core", name: "Core", orgId: "o1" },
          { id: "w1", slug: "core", name: "Core", orgId: "o1" },
          { id: "w9", slug: "other", name: "Other", orgId: "o9" },
        ],
      ),
    ).toEqual([
      {
        id: "o1",
        slug: "acme",
        name: "Acme",
        workspaces: [{ id: "w1", slug: "core", name: "Core" }],
      },
    ]);
  });

  it("loads scopes from the user's memberships only", async () => {
    liveMode();
    query.orgUsers.findMany.mockResolvedValue([{ orgId: "o1" }]);
    query.workspaceUsers.findMany.mockResolvedValue([{ workspaceId: "w1" }]);
    query.organizations.findMany.mockResolvedValue([
      { id: "o1", slug: "acme", name: "Acme" },
    ]);
    query.workspaces.findMany.mockResolvedValue([
      { id: "w1", slug: "core", name: "Core", orgId: "o1" },
    ]);
    expect(await cli.loadCliScopes("u1")).toHaveLength(1);
    expect(filters).toEqual([
      "orgUsers.findMany eq(col:userId,u1)",
      "workspaceUsers.findMany eq(col:userId,u1)",
      "organizations.findMany inArray(col:id,[o1])",
      "workspaces.findMany and(inArray(col:id,[w1]),inArray(col:orgId,[o1]))",
    ]);
    query.orgUsers.findMany.mockResolvedValue([]);
    expect(await cli.loadCliScopes("u1")).toEqual([]);
    fixtureMode();
    expect((await cli.loadCliScopes("u1"))[0]?.slug).toBe("acme");
  });
});

describe("approveCliAuth", () => {
  const approve = {
    ...valid,
    label: "laptop",
    org_slug: "acme",
    workspace_slug: "core",
  };

  function memberOfAcme() {
    query.orgUsers.findMany.mockResolvedValue([{ orgId: "o1" }]);
    query.workspaceUsers.findMany.mockResolvedValue([{ workspaceId: "w1" }]);
    query.organizations.findMany.mockResolvedValue([
      { id: "o1", slug: "acme", name: "Acme" },
    ]);
    query.workspaces.findMany.mockResolvedValue([
      { id: "w1", slug: "core", name: "Core", orgId: "o1" },
    ]);
  }

  it("sends a signed-out person to log in", async () => {
    liveMode();
    getAuthUser.mockResolvedValue(null);
    await expect(approveCliAuth(null, form(approve))).rejects.toThrow(
      "NEXT_REDIRECT /login",
    );
  });

  it("re-validates every parameter", async () => {
    liveMode();
    getAuthUser.mockResolvedValue({ id: "u1", email: "a@b.co", name: "A" });
    expect(
      await approveCliAuth(
        null,
        form({ ...approve, redirect_uri: "https://evil.example/cb" }),
      ),
    ).toEqual({ error: "invalid" });
    expect(
      await approveCliAuth(null, form({ ...approve, workspace_slug: "" })),
    ).toEqual({ error: "notFound" });
  });

  it("refuses in fixture mode, a workspace the user is not a member of, and a user who cannot manage keys", async () => {
    getAuthUser.mockResolvedValue({ id: "u1", email: "a@b.co", name: "A" });
    fixtureMode();
    expect(await approveCliAuth(null, form(approve))).toEqual({
      error: "fixture",
    });
    liveMode();
    memberOfAcme();
    expect(
      await approveCliAuth(
        null,
        form({ ...approve, workspace_slug: "someone-elses" }),
      ),
    ).toEqual({ error: "notMember" });
    actorCanManageApiKeys.mockResolvedValue(false);
    expect(await approveCliAuth(null, form(approve))).toEqual({
      error: "notPermitted",
    });
    expect(createCliAuthCode).not.toHaveBeenCalled();
  });

  it("mints a code bound to the scope and challenge, then redirects to the loopback listener", async () => {
    liveMode();
    getAuthUser.mockResolvedValue({ id: "u1", email: "a@b.co", name: "A" });
    memberOfAcme();
    actorCanManageApiKeys.mockResolvedValue(true);
    await expect(approveCliAuth(null, form(approve))).rejects.toThrow(
      "NEXT_REDIRECT http://127.0.0.1:53682/callback?code=code_123&state=st_1",
    );
    expect(createCliAuthCode).toHaveBeenCalledWith(
      "code_123",
      expect.objectContaining({
        userId: "u1",
        orgId: "o1",
        workspaceId: "w1",
        codeChallenge: CHALLENGE,
        label: "laptop",
      }),
      expect.any(Number),
    );
  });

  it("reports a failure to mint as failed", async () => {
    liveMode();
    getAuthUser.mockResolvedValue({ id: "u1", email: "a@b.co", name: "A" });
    memberOfAcme();
    actorCanManageApiKeys.mockResolvedValue(true);
    createCliAuthCode.mockRejectedValue(new Error("db"));
    expect(await approveCliAuth(null, form(approve))).toEqual({
      error: "failed",
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("cancelCliAuth", () => {
  it("returns access_denied to a valid loopback listener only", async () => {
    await expect(cancelCliAuth(null, form(valid))).rejects.toThrow(
      "NEXT_REDIRECT http://127.0.0.1:53682/callback?error=access_denied&state=st_1",
    );
    expect(
      await cancelCliAuth(
        null,
        form({ ...valid, redirect_uri: "https://evil.example/cb" }),
      ),
    ).toEqual({ error: "invalid" });
  });
});

describe("GitHub setup landing", () => {
  const queries = { matchInstallation: vi.fn(), mostRecentMembership: vi.fn() };

  beforeEach(() => {
    queries.matchInstallation.mockReset();
    queries.mostRecentMembership.mockReset();
  });

  it("lands on the matched workspace's sources", async () => {
    queries.matchInstallation.mockResolvedValue([
      { orgSlug: "acme", workspaceSlug: "core" },
    ]);
    expect(await github.resolveGithubSetupTarget("u1", "123", queries)).toBe(
      "/acme/core/ontology/sources?setup=github",
    );
  });

  it("falls back to the most recent membership's repositories, its org, or onboarding", async () => {
    queries.matchInstallation.mockResolvedValue([]);
    queries.mostRecentMembership.mockResolvedValueOnce([
      { orgSlug: "acme", workspaceSlug: "core" },
    ]);
    expect(await github.resolveGithubSetupTarget("u1", "123", queries)).toBe(
      "/acme/core/ontology/repositories?github_installed=1",
    );
    queries.mostRecentMembership.mockResolvedValueOnce([
      { orgSlug: "acme", workspaceSlug: null },
    ]);
    expect(
      await github.resolveGithubSetupTarget("u1", undefined, queries),
    ).toBe("/acme");
    queries.mostRecentMembership.mockResolvedValueOnce([]);
    expect(
      await github.resolveGithubSetupTarget("u1", undefined, queries),
    ).toBe("/welcome");
    expect(queries.matchInstallation).toHaveBeenCalledOnce();
  });

  it("ignores an installation id that is not a positive integer", () => {
    expect(github.parseInstallationId("12345")).toBe("12345");
    expect(github.parseInstallationId("0")).toBeUndefined();
    expect(github.parseInstallationId("1 OR 1=1")).toBeUndefined();
    expect(github.parseInstallationId(undefined)).toBeUndefined();
  });

  it("fixture queries land in the fixture workspace", async () => {
    fixtureMode();
    const q = githubSetupQueries();
    expect(await github.resolveGithubSetupTarget("u1", "123", q)).toBe(
      "/acme/core-platform/ontology/repositories?github_installed=1",
    );
  });

  it("live · matches an installation only in the user's orgs, most recent first", async () => {
    liveMode();
    const q = githubSetupQueries();
    query.orgUsers.findMany.mockResolvedValue([{ orgId: "o1" }]);
    query.sourceConnections.findMany.mockResolvedValue([
      {
        orgId: "o1",
        workspaceId: "w0",
        deliveryConfig: { installationId: 999 },
        updatedAt: new Date(),
      },
      {
        orgId: "o1",
        workspaceId: "w1",
        deliveryConfig: { installationId: "123" },
        updatedAt: new Date(),
      },
      {
        orgId: "o1",
        workspaceId: "w2",
        deliveryConfig: null,
        updatedAt: new Date(),
      },
    ]);
    query.organizations.findFirst.mockResolvedValue({ slug: "acme" });
    query.workspaces.findFirst.mockResolvedValue({ slug: "core" });
    expect(await q.matchInstallation("u1", "123")).toEqual([
      { orgSlug: "acme", workspaceSlug: "core" },
    ]);
    expect(filters).toContain(
      "sourceConnections.findMany and(eq(col:connectorId,github),inArray(col:orgId,[o1]),isNull(col:deletedAt)) desc(col:updatedAt)",
    );
    expect(filters).toContain(
      "organizations.findFirst and(eq(col:id,o1),ne(col:status,deleted))",
    );
    expect(await q.matchInstallation("u1", "555")).toEqual([]);
    query.orgUsers.findMany.mockResolvedValue([]);
    expect(await q.matchInstallation("u1", "123")).toEqual([]);
  });

  it("live · the most recent membership skips a deleted org", async () => {
    liveMode();
    const q = githubSetupQueries();
    query.orgUsers.findMany.mockResolvedValue([
      { orgId: "o-deleted" },
      { orgId: "o1" },
    ]);
    query.organizations.findFirst
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ slug: "acme" });
    query.workspaces.findFirst.mockResolvedValue(undefined);
    expect(await q.mostRecentMembership("u1")).toEqual([
      { orgSlug: "acme", workspaceSlug: null },
    ]);
    expect(filters).toContain(
      "orgUsers.findMany eq(col:userId,u1) desc(col:joinedAt)",
    );
    query.orgUsers.findMany.mockResolvedValue([]);
    expect(await q.mostRecentMembership("u1")).toEqual([]);
  });
});
