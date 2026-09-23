import type { CapabilityContext } from "@oxagen/oxagen";
import type { Tx } from "@oxagen/database";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), db: vi.fn() }));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.db,
  withOrgDb: mocks.db,
}));
vi.mock("./lib/tacho-host", () => ({ resolveEnrolledHost: mocks.resolve }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import {
  createTachoGithubTokenIssueHandler,
  selectGovernedRepository,
  type GithubTokenIssueDeps,
} from "./tacho.github_token.issue";
import { tachoGithubTokenIssue } from "@oxagen/oxagen/contracts/tacho.github_token.issue";
const ctx: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: null,
  apiKeyId: "host-key",
  requestId: "req",
  messageId: null,
  surface: "api",
};
const input = {
  host_enrollment_id: "tch_0123456789abcdefghjkmn",
  owner: "Acme",
  name: "Repo",
  run_token_id: "rt_0123456789abcdef0123",
};
const repo = {
  owner: "Acme",
  name: "Repo",
  fullName: "Acme/Repo",
  providerRepositoryId: "42",
  role: "main" as const,
};
function deps() {
  return {
    enabled: (): boolean => true,
    governedRepository: vi.fn(async () => repo),
    installation: vi.fn(async () => ({ installationId: "9" })),
    mint: vi.fn(async () => ({
      token: "ghs_scoped",
      expiresAt: Date.parse("2027-01-01T00:00:00Z"),
    })),
  } satisfies GithubTokenIssueDeps;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ status: "active" });
  mocks.db.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
});
describe("repository-scoped GitHub credentials", () => {
  it("checks the enrolled host and selects the installation server-side", async () => {
    const d = deps();
    const result = await createTachoGithubTokenIssueHandler(d)(input, ctx);
    expect(mocks.resolve).toHaveBeenCalledWith(
      "issue_tacho_github_token",
      ctx,
      {},
      input.host_enrollment_id,
    );
    expect(d.governedRepository).toHaveBeenCalledWith(
      {},
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "Acme",
      "Repo",
    );
    expect(d.installation).toHaveBeenCalledWith({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    });
    expect(d.mint).toHaveBeenCalledWith({
      installationId: "9",
      repositoryId: 42,
    });
    expect(tachoGithubTokenIssue.output.parse(result)).toMatchObject({
      token: "ghs_scoped",
      repository: { full_name: "Acme/Repo" },
    });
  });
  it("does not mint for a disabled deployment or an invalid host", async () => {
    const d = deps();
    d.enabled = () => false;
    await expect(
      createTachoGithubTokenIssueHandler(d)(input, ctx),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    d.enabled = () => true;
    mocks.resolve.mockRejectedValue(new Error("wrong host key"));
    await expect(
      createTachoGithubTokenIssueHandler(d)(input, ctx),
    ).rejects.toThrow("wrong host key");
    expect(d.mint).not.toHaveBeenCalled();
  });
  it.each(["paused", "suspended", "revoked"])(
    "refuses an inactive host: %s",
    async (status) => {
      const d = deps();
      mocks.resolve.mockResolvedValue({ status });
      await expect(
        createTachoGithubTokenIssueHandler(d)(input, ctx),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(d.mint).not.toHaveBeenCalled();
    },
  );
  it.each(["unbound", "bad-id", "disconnected", "provider"])(
    "refuses %s without broadening scope",
    async (reason) => {
      const d: GithubTokenIssueDeps = deps();
      if (reason === "unbound") d.governedRepository = async () => null;
      if (reason === "bad-id")
        d.governedRepository = async () => ({
          ...repo,
          providerRepositoryId: "9007199254740993",
        });
      if (reason === "disconnected") d.installation = async () => null;
      if (reason === "provider")
        d.mint = async () => {
          throw new Error("provider-sensitive-response");
        };
      const error = await createTachoGithubTokenIssueHandler(d)(
        input,
        ctx,
      ).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(
        "provider-sensitive-response",
      );
    },
  );
  it("rejects caller-selected installations, path injection, and missing audit identity", () => {
    for (const bad of [
      { ...input, installation_id: "evil" },
      { ...input, name: "../repo" },
      { ...input, run_token_id: undefined },
    ])
      expect(tachoGithubTokenIssue.input.safeParse(bad).success).toBe(false);
  });
  it("compiles a tenant-scoped current-binding query with both repository names", async () => {
    let predicate: SQL | undefined;
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: (sql: SQL) => {
        predicate = sql;
        return chain;
      },
      limit: async () => [repo],
    };
    expect(
      await selectGovernedRepository(
        { select: () => chain } as unknown as Tx,
        ctx,
        "Acme",
        "Repo",
      ),
    ).toEqual(repo);
    const compiled = new PgDialect().sqlToQuery(predicate!);
    expect(compiled.params).toEqual([
      ctx.orgId,
      ctx.workspaceId,
      "github",
      "Acme",
      "Repo",
    ]);
    expect(compiled.sql).toContain('"workspace_id"');
    expect(compiled.sql).toContain("lower(");
  });
});
