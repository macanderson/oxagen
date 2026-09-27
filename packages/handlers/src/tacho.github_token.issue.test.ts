import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { Tx } from "@oxagen/database";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  db: vi.fn(),
  role: vi.fn(),
  actingUser: vi.fn(),
  steeringMint: vi.fn(),
}));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.db,
  withOrgDb: mocks.db,
}));
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.role,
  resolveActingUserId: mocks.actingUser,
}));
vi.mock("./lib/tacho-host", () => ({ resolveEnrolledHost: mocks.resolve }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
// The handler must never mint an Oxagen Steering app token. The spy catches a
// call if a later change imports the minter.
vi.mock("./lib/steering-app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/steering-app")>()),
  mintSteeringInstallationToken: mocks.steeringMint,
}));
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
/** The columns `selectGovernedRepository` reads, less the head's role. */
const head = {
  owner: "Acme",
  name: "Repo",
  fullName: "Acme/Repo",
  providerRepositoryId: "42",
};
const repo = { ...head, role: "linked" as const, steering: false };
const steeringRepo = { ...head, role: "main" as const, steering: true };
const PROPOSE_ONLY_MESSAGE =
  "The steering repository takes changes through a steering PR. Call steering_propose, or push a branch from a clone with a credential that can write to it.";
/** What GitHub's mint answers for a repository the installation lacks. */
const NOT_COVERED = new Error(
  "GitHub App token mint failed (422): There is at least one repository that does not exist or is not accessible to the parent installation.",
);
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
  mocks.role.mockResolvedValue("Owner");
  mocks.actingUser.mockResolvedValue("operator");
  mocks.resolve.mockResolvedValue({ status: "active" });
  mocks.db.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
});
describe("repository-scoped GitHub credentials", () => {
  it("checks the enrolled host and selects the installation server-side", async () => {
    const d = deps();
    const result = await createTachoGithubTokenIssueHandler(d)(input, ctx);
    expect(mocks.resolve).toHaveBeenCalledWith(
      "create_github_token",
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
  it("refuses a host whose key creator no longer holds the declared role", async () => {
    const d = deps();
    mocks.role.mockRejectedValue(new Error("role removed"));
    await expect(
      createTachoGithubTokenIssueHandler(d)(input, ctx),
    ).rejects.toThrow("role removed");
    expect(mocks.role).toHaveBeenCalledWith(
      { ...ctx, userId: "operator" },
      { org: ["Owner", "Admin"] },
    );
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
      limit: async () => [{ ...head, role: "linked" }],
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
  it("reads a steering head as the main repository, not a linked one", async () => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: async () => [{ ...head, role: "steering" }],
    };
    const row = await selectGovernedRepository(
      { select: () => chain } as unknown as Tx,
      ctx,
      "Acme",
      "Repo",
    );
    expect(row).toEqual(steeringRepo);
  });
});

describe("the steering repository", () => {
  it("gets the workspace installation's token when it covers the repository", async () => {
    const d = deps();
    d.governedRepository.mockResolvedValue(steeringRepo);
    const result = await createTachoGithubTokenIssueHandler(d)(input, ctx);
    expect(d.mint).toHaveBeenCalledWith({
      installationId: "9",
      repositoryId: 42,
    });
    expect(tachoGithubTokenIssue.output.parse(result)).toMatchObject({
      token: "ghs_scoped",
      repository: { full_name: "Acme/Repo", role: "main" },
    });
  });
  it("refuses steering_repo_propose_only when no workspace installation exists", async () => {
    const d = deps();
    d.governedRepository.mockResolvedValue(steeringRepo);
    d.installation.mockResolvedValue(null);
    await expect(
      createTachoGithubTokenIssueHandler(d)(input, ctx),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_repo_propose_only",
      message: PROPOSE_ONLY_MESSAGE,
    });
    expect(d.mint).not.toHaveBeenCalled();
  });
  it("maps GitHub's 422 on the mint to steering_repo_propose_only", async () => {
    const d = deps();
    d.governedRepository.mockResolvedValue(steeringRepo);
    d.mint.mockRejectedValue(NOT_COVERED);
    const error = await createTachoGithubTokenIssueHandler(d)(
      input,
      ctx,
    ).catch((error: Error) => error);
    expect(error).toMatchObject({
      code: "conflict",
      reason: "steering_repo_propose_only",
      message: PROPOSE_ONLY_MESSAGE,
    });
    expect((error as Error).message).not.toContain("parent installation");
  });
  it.each([401, 404, 500])(
    "keeps github_refused when the steering repository's mint fails with %s",
    async (status) => {
      const d = deps();
      d.governedRepository.mockResolvedValue(steeringRepo);
      d.mint.mockRejectedValue(
        new Error(`GitHub App token mint failed (${status}): refused`),
      );
      await expect(
        createTachoGithubTokenIssueHandler(d)(input, ctx),
      ).rejects.toMatchObject({ code: "conflict", reason: "github_refused" });
    },
  );
  it("keeps today's refusals for a repository that is not the steering repository", async () => {
    const refused = deps();
    refused.mint.mockRejectedValue(NOT_COVERED);
    await expect(
      createTachoGithubTokenIssueHandler(refused)(input, ctx),
    ).rejects.toMatchObject({ code: "conflict", reason: "github_refused" });
    const unconnected = deps();
    unconnected.installation.mockResolvedValue(null);
    await expect(
      createTachoGithubTokenIssueHandler(unconnected)(input, ctx),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "github_not_connected",
    });
  });
  it("never mints an Oxagen Steering app token", async () => {
    const source = readFileSync(
      join(__dirname, "tacho.github_token.issue.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"\.\/lib\/steering-app"/);
    expect(source).not.toContain("mintSteeringInstallationToken");
    for (const setup of ["covered", "uncovered", "unconnected"]) {
      const d = deps();
      d.governedRepository.mockResolvedValue(steeringRepo);
      if (setup === "uncovered") d.mint.mockRejectedValue(NOT_COVERED);
      if (setup === "unconnected") d.installation.mockResolvedValue(null);
      await createTachoGithubTokenIssueHandler(d)(input, ctx).catch(
        () => undefined,
      );
    }
    expect(mocks.steeringMint).not.toHaveBeenCalled();
  });
});
