// readBoundRepository refuses a GitLab binding by name (#3762): the three
// capabilities built on it read and write through a GitHub App installation.
// workspaceGithub reads a provisioned steering repository through the Oxagen
// Steering app, and every other repository through the workspace's own app,
// with a token for that one repository and the call's permissions (#4753).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  resolveWorkspaceGithubInstallation: vi.fn(),
  getInstallationToken: vi.fn(),
  createGitHubClient: vi.fn(),
  mintSteeringInstallationToken: vi.fn(),
}));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withOrgDb: mocks.withTenantDb,
  };
});
vi.mock("@oxagen/github", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/github")>();
  return {
    ...real,
    getInstallationToken: mocks.getInstallationToken,
    createGitHubClient: mocks.createGitHubClient,
  };
});
vi.mock("./repository.github-connection", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("./repository.github-connection")>();
  return {
    ...real,
    resolveWorkspaceGithubInstallation:
      mocks.resolveWorkspaceGithubInstallation,
  };
});
vi.mock("./lib/steering-app", async (importOriginal) => {
  const real = await importOriginal<typeof import("./lib/steering-app")>();
  return {
    ...real,
    mintSteeringInstallationToken: mocks.mintSteeringInstallationToken,
  };
});

import {
  readBoundRepository,
  requireWorkspaceGithub,
  workspaceGithub,
  type RepositoryAccess,
} from "./repository.bound";
import {
  githubTokenFetch,
  TEST_APP_PRIVATE_KEY,
} from "./test-utils/github-token-mint";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

function answer(row: Record<string, unknown> | null) {
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({ limit: async () => (row ? [row] : []) }),
            }),
          }),
        }),
      }),
  );
}

const ROW = {
  headId: "head-uuid",
  role: "main",
  provider: "github",
  connectionId: "conn-uuid",
  providerRepositoryId: "9001",
  bindingRowId: "binding-uuid",
  bindingId: "rpb_0123abcd",
  version: 1,
  owner: "acme",
  name: "widgets",
  fullName: "acme/widgets",
  productionBranch: "main",
};

/** The repository a call names, and what it asks the token to hold. */
const ACCESS: RepositoryAccess = {
  providerRepositoryId: "9001",
  name: "widgets",
  fullName: "acme/widgets",
  permissions: { metadata: "read", contents: "read" },
};

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("readBoundRepository", () => {
  it("answers a GitHub binding", async () => {
    answer(ROW);
    await expect(
      readBoundRepository(SCOPE, "rpb_0123abcd"),
    ).resolves.toMatchObject({ provider: "github", fullName: "acme/widgets" });
  });

  it("reads a steering head as the main repository, not a linked one", async () => {
    answer({ ...ROW, role: "steering" });
    await expect(
      readBoundRepository(SCOPE, "rpb_0123abcd"),
    ).resolves.toMatchObject({ role: "main" });
  });

  it("refuses a GitLab binding by name rather than reaching for GitHub", async () => {
    answer({ ...ROW, provider: "gitlab", fullName: "acme/platform/rules" });
    await expect(
      readBoundRepository(SCOPE, "rpb_0123abcd"),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "repository_host_unsupported",
    });
  });

  it("refuses an id no head in this workspace carries", async () => {
    answer(null);
    await expect(readBoundRepository(SCOPE, "rpb_ffff")).rejects.toMatchObject({
      reason: "repository_not_linked",
    });
  });
});

/**
 * Answer the connection read `workspaceGithub.client` makes, and keep the
 * predicate it filtered on.
 */
function connection(row: Record<string, unknown> | null) {
  const where: unknown[] = [];
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: (predicate: unknown) => {
              where.push(predicate);
              return { limit: async () => (row ? [row] : []) };
            },
          }),
        }),
      }),
  );
  return where;
}

describe("workspaceGithub.client", () => {
  const WORKSPACE_CLIENT = { kind: "workspace" };
  const STEERING_CLIENT = { kind: "steering" };

  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", "101");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "workspace-key");
    mocks.resolveWorkspaceGithubInstallation.mockResolvedValue({
      id: "workspace-conn",
      publicId: "con_1",
      status: "active",
      installationId: "555",
    });
    mocks.getInstallationToken.mockResolvedValue({ token: "workspace-tok" });
    mocks.mintSteeringInstallationToken.mockResolvedValue("steering-tok");
    mocks.createGitHubClient.mockImplementation(({ token }) =>
      token === "steering-tok" ? STEERING_CLIENT : WORKSPACE_CLIENT,
    );
  });

  it("reads through the workspace's installation when no connection is named", async () => {
    await expect(
      workspaceGithub.client(SCOPE, undefined, ACCESS),
    ).resolves.toBe(WORKSPACE_CLIENT);
    expect(mocks.getInstallationToken).toHaveBeenCalledWith({
      appId: "101",
      privateKey: "workspace-key",
      installationId: "555",
      repositoryIds: [9001],
      permissions: { metadata: "read", contents: "read" },
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.mintSteeringInstallationToken).not.toHaveBeenCalled();
  });

  it("keeps the workspace's installation for a head on its own GitHub connection", async () => {
    connection({
      connectorId: "github",
      deliveryConfig: { installationId: "555" },
    });
    await expect(
      workspaceGithub.client(SCOPE, "conn-uuid", ACCESS),
    ).resolves.toBe(WORKSPACE_CLIENT);
    expect(mocks.getInstallationToken).toHaveBeenCalled();
    expect(mocks.mintSteeringInstallationToken).not.toHaveBeenCalled();
  });

  it("falls back to the workspace's installation when the named connection is retired or gone", async () => {
    connection(null);
    await expect(
      workspaceGithub.client(SCOPE, "conn-uuid", ACCESS),
    ).resolves.toBe(WORKSPACE_CLIENT);
    expect(mocks.mintSteeringInstallationToken).not.toHaveBeenCalled();
  });

  it("reads only a live connection in this workspace", async () => {
    const where = connection(null);
    await workspaceGithub.client(SCOPE, "conn-uuid", ACCESS);
    const query = new PgDialect().sqlToQuery(where[0] as SQL);
    expect(query.params).toEqual(
      expect.arrayContaining([
        SCOPE.orgId,
        SCOPE.workspaceId,
        "conn-uuid",
        "deleting",
        "deleted",
      ]),
    );
    expect(query.sql).toMatch(/"deleted_at" is null/);
  });

  it.each([
    ["a number", 4242],
    ["a string of digits", "4242"],
  ])(
    "mints the Oxagen GitHub App token for a github_steering head whose installation id is %s",
    async (_label, installationId) => {
      // A workspace whose only repository is its steering repository has no
      // installation of its own. The steering head must still read.
      mocks.resolveWorkspaceGithubInstallation.mockResolvedValue(null);
      connection({
        connectorId: "github_steering",
        deliveryConfig: { installationId, owner: "acme" },
      });
      await expect(
        workspaceGithub.client(SCOPE, "conn-uuid", ACCESS),
      ).resolves.toBe(STEERING_CLIENT);
      expect(mocks.mintSteeringInstallationToken).toHaveBeenCalledWith(4242);
      expect(mocks.createGitHubClient).toHaveBeenCalledWith({
        token: "steering-tok",
      });
      expect(mocks.resolveWorkspaceGithubInstallation).not.toHaveBeenCalled();
      expect(mocks.getInstallationToken).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["no delivery config", null],
    ["no installation id", { owner: "acme" }],
    ["a zero installation id", { installationId: 0 }],
    ["an installation id that is not a number", { installationId: "abc" }],
  ])(
    "refuses a github_steering head with %s",
    async (_label, deliveryConfig) => {
      connection({ connectorId: "github_steering", deliveryConfig });
      await expect(
        workspaceGithub.client(SCOPE, "conn-uuid", ACCESS),
      ).rejects.toMatchObject({
        code: "conflict",
        reason: "steering_installation_missing",
      });
      expect(mocks.mintSteeringInstallationToken).not.toHaveBeenCalled();
      expect(mocks.resolveWorkspaceGithubInstallation).not.toHaveBeenCalled();
      expect(mocks.getInstallationToken).not.toHaveBeenCalled();
    },
  );
});

// The narrowing as GitHub receives it: the real mint, in front of a fake
// api.github.com that records each access-token request body (#4753).
describe("the workspace token's narrowing", () => {
  const CLIENT = { kind: "workspace" };

  beforeEach(async () => {
    const real =
      await vi.importActual<typeof import("@oxagen/github")>("@oxagen/github");
    mocks.getInstallationToken.mockImplementation(real.getInstallationToken);
    mocks.createGitHubClient.mockReturnValue(CLIENT);
    vi.stubEnv("GITHUB_APP_ID", "101");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", TEST_APP_PRIVATE_KEY);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** The workspace's installation. The mint caches per id, so each test names its own. */
  function installation(installationId: string) {
    mocks.resolveWorkspaceGithubInstallation.mockResolvedValue({
      id: "workspace-conn",
      publicId: "con_1",
      status: "active",
      installationId,
    });
  }

  it("asks for the one bound repository by id, with only the call's permissions", async () => {
    installation("47531");
    const github = githubTokenFetch();
    vi.stubGlobal("fetch", github.fetch);
    await expect(
      workspaceGithub.client(SCOPE, undefined, ACCESS),
    ).resolves.toBe(CLIENT);
    expect(github.mints).toEqual([
      {
        installationId: "47531",
        body: {
          repository_ids: [9001],
          permissions: { contents: "read", metadata: "read" },
        },
      },
    ]);
    expect(mocks.createGitHubClient).toHaveBeenCalledWith({
      token: "ghs_test",
    });
  });

  it("asks for the repository by name when the stored id does not read as one", async () => {
    installation("47532");
    const github = githubTokenFetch();
    vi.stubGlobal("fetch", github.fetch);
    await workspaceGithub.client(SCOPE, undefined, {
      ...ACCESS,
      providerRepositoryId: "R_kgDO",
    });
    expect(github.mints[0]?.body).toEqual({
      repositories: ["widgets"],
      permissions: { contents: "read", metadata: "read" },
    });
  });

  it("sends the bound head's repository and the caller's permissions through requireWorkspaceGithub", async () => {
    installation("47533");
    // The head hangs from the workspace's own GitHub connection.
    connection({
      connectorId: "github",
      deliveryConfig: { installationId: "47533" },
    });
    const github = githubTokenFetch();
    vi.stubGlobal("fetch", github.fetch);
    await requireWorkspaceGithub(
      workspaceGithub,
      SCOPE,
      {
        connectionId: "conn-uuid",
        providerRepositoryId: "9002",
        name: "gadgets",
        fullName: "acme/gadgets",
      },
      { metadata: "read", contents: "read", pull_requests: "read" },
    );
    expect(github.mints[0]?.body).toEqual({
      repository_ids: [9002],
      permissions: {
        contents: "read",
        metadata: "read",
        pull_requests: "read",
      },
    });
  });

  it("refuses with repository_not_installed when GitHub will not mint for the repository", async () => {
    installation("47534");
    const github = githubTokenFetch({
      mintStatus: 422,
      mintMessage:
        "There is at least one repository that does not exist or is not accessible to the parent installation.",
    });
    vi.stubGlobal("fetch", github.fetch);
    await expect(
      workspaceGithub.client(SCOPE, undefined, ACCESS),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "repository_not_installed",
    });
    expect(mocks.createGitHubClient).not.toHaveBeenCalled();
  });

  it("lets any other mint failure through unchanged", async () => {
    installation("47535");
    vi.stubGlobal(
      "fetch",
      githubTokenFetch({ mintStatus: 401, mintMessage: "Bad credentials" })
        .fetch,
    );
    await expect(
      workspaceGithub.client(SCOPE, undefined, ACCESS),
    ).rejects.toThrow("GitHub App token mint failed (401): Bad credentials");
  });
});
