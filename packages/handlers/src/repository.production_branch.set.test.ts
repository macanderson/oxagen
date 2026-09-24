// `set_production_branch` (MC spec §10.1, §11.4): confirm or move the branch a
// bound repository is read at. The role gate follows the repository's role,
// confirming the same branch writes nothing, and a move is checked against
// GitHub before the successor binding version is written.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(async (c: { userId: string | null }) => c.userId),
}));

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { repositoryProductionBranchSet } from "@oxagen/oxagen/contracts/repository.production_branch.set";
import type { BoundRepository } from "./repository.bound";
import {
  createProductionBranchSetHandler,
  productionBranchRoles,
  type ProductionBranchWrite,
} from "./repository.production_branch.set";

const NOW = new Date("2026-09-19T10:00:00.000Z");

const BOUND: BoundRepository = {
  headId: "head-1",
  role: "main",
  provider: "github",
  connectionId: "conn-1",
  providerRepositoryId: "42",
  bindingRowId: "binding-row-1",
  bindingId: "rpb_0a1b",
  version: 1,
  owner: "acme",
  name: "widgets",
  fullName: "acme/widgets",
  productionBranch: "main",
};

const REPO = {
  id: "42",
  owner: "acme",
  name: "widgets",
  fullName: "acme/widgets",
  htmlUrl: "https://github.com/acme/widgets",
  defaultBranch: "trunk",
};

function fakeGithub(overrides: Partial<GitHubClient> = {}) {
  return {
    getRepoInfo: vi.fn(async () => REPO),
    getBranch: vi.fn(async () => ({ name: "release", sha: "def456" })),
    ...overrides,
  } as unknown as GitHubClient;
}

function setup(
  options: { client?: GitHubClient | null; bound?: BoundRepository } = {},
) {
  const client = options.client === undefined ? fakeGithub() : options.client;
  const write = vi.fn(async (args: ProductionBranchWrite) => ({
    bindingId: "rpb_0a1c",
    previousBranch: "main",
    changed: args.branch !== "main",
  }));
  const handler = createProductionBranchSetHandler({
    github: { client: async () => client },
    readBound: async () => options.bound ?? BOUND,
    write,
    now: () => NOW,
  });
  return { handler, write, client };
}

beforeEach(() => {
  mocks.assertOrgRole.mockClear();
  mocks.assertOrgRole.mockImplementation(async () => "Owner");
});

describe("productionBranchRoles", () => {
  it("keeps the main repository to org Owner and Admin, and admits the workspace Owner on a linked one", () => {
    expect(productionBranchRoles("main")).toEqual({ org: ["Owner", "Admin"] });
    expect(productionBranchRoles("linked")).toEqual({
      org: ["Owner", "Admin"],
      workspace: ["Owner"],
    });
  });
});

describe("set_production_branch", () => {
  it("writes a successor binding when the branch moves and GitHub has it", async () => {
    const { handler, write, client } = setup();
    const out = await handler(
      { bindingId: "rpb_0a1b", branch: "release" },
      makeCTX(),
    );
    expect(out).toEqual({
      bindingId: "rpb_0a1c",
      fullName: "acme/widgets",
      productionBranch: "release",
      previousBranch: "main",
      changed: true,
      setAt: NOW.toISOString(),
    });
    expect(repositoryProductionBranchSet.output.safeParse(out).success).toBe(
      true,
    );
    expect(client?.getBranch).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      branch: "release",
    });
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: "rpb_0a1b",
        branch: "release",
        repo: REPO,
        now: NOW,
      }),
    );
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(expect.anything(), {
      org: ["Owner", "Admin"],
    });
  });

  it("answers changed false and reaches neither GitHub nor the store when the branch is already the one recorded", async () => {
    const client = fakeGithub();
    const { handler, write } = setup({ client });
    const out = await handler(
      { bindingId: "rpb_0a1b", branch: "main" },
      makeCTX(),
    );
    expect(out.changed).toBe(false);
    expect(out.previousBranch).toBe("main");
    expect(write).not.toHaveBeenCalled();
    expect(client.getRepoInfo).not.toHaveBeenCalled();
  });

  it("gates a linked repository with the workspace Owner admitted", async () => {
    const { handler } = setup({ bound: { ...BOUND, role: "linked" } });
    await handler({ bindingId: "rpb_0a1b", branch: "release" }, makeCTX());
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(expect.anything(), {
      org: ["Owner", "Admin"],
      workspace: ["Owner"],
    });
  });

  it("stops at the role gate before anything is read from GitHub", async () => {
    mocks.assertOrgRole.mockImplementation(async () => {
      throw new HandlerError({ code: "forbidden", reason: "role_required" });
    });
    const { handler, write, client } = setup();
    await expect(
      handler({ bindingId: "rpb_0a1b", branch: "release" }, makeCTX()),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(client?.getRepoInfo).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses with branch_not_found when GitHub has no such branch", async () => {
    const { handler, write } = setup({
      client: fakeGithub({ getBranch: vi.fn(async () => null) }),
    });
    await expect(
      handler({ bindingId: "rpb_0a1b", branch: "nope" }, makeCTX()),
    ).rejects.toMatchObject({ code: "not_found", reason: "branch_not_found" });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses with repository_not_installed when the installation cannot see the repository", async () => {
    const { handler } = setup({
      client: fakeGithub({
        getRepoInfo: vi.fn(async () => {
          throw new Error("GitHub API error 404: Not Found");
        }),
      }),
    });
    await expect(
      handler({ bindingId: "rpb_0a1b", branch: "release" }, makeCTX()),
    ).rejects.toMatchObject({ reason: "repository_not_installed" });
  });

  it("refuses a repository re-created under the same name, which has a new id", async () => {
    const { handler, write } = setup({
      client: fakeGithub({
        getRepoInfo: vi.fn(async () => ({ ...REPO, id: "99" })),
      }),
    });
    await expect(
      handler({ bindingId: "rpb_0a1b", branch: "release" }, makeCTX()),
    ).rejects.toMatchObject({ reason: "repository_not_installed" });
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses with github_not_connected when no installation is attached", async () => {
    const { handler } = setup({ client: null });
    await expect(
      handler({ bindingId: "rpb_0a1b", branch: "release" }, makeCTX()),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "github_not_connected",
    });
  });

  it("passes any other GitHub failure through unchanged", async () => {
    const { handler } = setup({
      client: fakeGithub({
        getRepoInfo: vi.fn(async () => {
          throw new Error("GitHub API error 502: Bad Gateway");
        }),
      }),
    });
    await expect(
      handler({ bindingId: "rpb_0a1b", branch: "release" }, makeCTX()),
    ).rejects.toThrow("502");
  });
});
