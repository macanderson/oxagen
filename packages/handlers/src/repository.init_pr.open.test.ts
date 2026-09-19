// `open_init_pr` (MC spec §10.2; the init wizard): the two reviewed files are
// checked before anything reaches GitHub, an open init pull request is
// answered as it is, a repository that already has `.oxagen/` is refused, and
// otherwise the files land on `oxagen/init` with one pull request back into
// the production branch. Nothing is written to the production branch.
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

import { repositoryInitPrOpen } from "@oxagen/oxagen/contracts/repository.init_pr.open";
import type { BoundRepository } from "./repository.bound";
import {
  createInitPrOpenHandler,
  gitignoreWithOxagen,
} from "./repository.init_pr.open";

const NOW = new Date("2026-09-19T10:00:00.000Z");

const BOUND: BoundRepository = {
  headId: "head-1",
  role: "linked",
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

const INPUT = {
  bindingId: "rpb_0a1b",
  governanceMode: "team" as const,
  workspaceToml: 'schema = "oxagen-workspace/v0.1"\n',
  governanceToml: 'mode = "team"\n',
};

function fakeGithub(overrides: Partial<GitHubClient> = {}) {
  return {
    findOpenPullRequest: vi.fn(async () => null),
    getBranch: vi.fn(async () => ({ name: "main", sha: "abc123" })),
    getTree: vi.fn(async () => ["README.md", ".gitignore"]),
    getFileContent: vi.fn(async () => "node_modules/\n"),
    createBranch: vi.fn(async () => undefined),
    putFile: vi.fn(async () => undefined),
    openPullRequest: vi.fn(async () => ({
      number: 7,
      htmlUrl: "https://github.com/acme/widgets/pull/7",
    })),
    ...overrides,
  } as unknown as GitHubClient;
}

function handler(client: GitHubClient | null) {
  return createInitPrOpenHandler({
    github: { client: async () => client },
    readBound: async () => BOUND,
    now: () => NOW,
  });
}

beforeEach(() => {
  mocks.assertOrgRole.mockClear();
  mocks.assertOrgRole.mockImplementation(async () => "Owner");
});

describe("gitignoreWithOxagen", () => {
  it("adds the machine-local lines to a file that lacks them, keeping what it had", () => {
    expect(gitignoreWithOxagen("node_modules/")).toBe(
      "node_modules/\n\n# Oxagen: this machine's link to a workspace; never committed.\n.oxagen/workspace.json\n.stella/private/\n",
    );
  });

  it("writes a new file when the repository has none", () => {
    expect(gitignoreWithOxagen(null)).toBe(
      "# Oxagen: this machine's link to a workspace; never committed.\n.oxagen/workspace.json\n.stella/private/\n",
    );
  });

  it("adds only the missing line, and nothing when both are there", () => {
    expect(gitignoreWithOxagen(".oxagen/workspace.json\n")).toContain(
      ".stella/private/",
    );
    expect(
      gitignoreWithOxagen(".oxagen/workspace.json\r\n.stella/private/\r\n"),
    ).toBeNull();
  });
});

describe("open_init_pr", () => {
  it("pushes the six files to oxagen/init and opens one pull request into the production branch", async () => {
    const client = fakeGithub();
    const out = await handler(client)(INPUT, makeCTX());
    expect(out).toEqual({
      bindingId: "rpb_0a1b",
      fullName: "acme/widgets",
      branch: "oxagen/init",
      base: "main",
      pullRequest: {
        number: 7,
        htmlUrl: "https://github.com/acme/widgets/pull/7",
      },
      files: [
        ".oxagen/workspace.toml",
        ".oxagen/rules/governance.toml",
        ".oxagen/rules/.gitkeep",
        ".oxagen/proposals/.gitkeep",
        ".oxagen/agents/.gitkeep",
        ".gitignore",
      ],
      reused: false,
      openedAt: NOW.toISOString(),
    });
    expect(repositoryInitPrOpen.output.safeParse(out).success).toBe(true);
    expect(client.createBranch).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      branch: "oxagen/init",
      fromBranch: "main",
    });
    // Every push goes to the init branch; none reaches the production branch.
    const puts = vi.mocked(client.putFile).mock.calls.map(([args]) => args);
    expect(puts.every((args) => args.branch === "oxagen/init")).toBe(true);
    expect(client.openPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ head: "oxagen/init", base: "main" }),
    );
  });

  it("answers an init pull request that is already open, and pushes nothing", async () => {
    const client = fakeGithub({
      findOpenPullRequest: vi.fn(async () => ({
        number: 3,
        htmlUrl: "https://github.com/acme/widgets/pull/3",
        body: "",
      })),
    });
    const out = await handler(client)(INPUT, makeCTX());
    expect(out.reused).toBe(true);
    expect(out.files).toEqual([]);
    expect(out.pullRequest.number).toBe(3);
    expect(client.putFile).not.toHaveBeenCalled();
    expect(client.openPullRequest).not.toHaveBeenCalled();
  });

  it("leaves .gitignore out when it already ignores both paths", async () => {
    const client = fakeGithub({
      getFileContent: vi.fn(
        async () => ".oxagen/workspace.json\n.stella/private/\n",
      ),
    });
    const out = await handler(client)(INPUT, makeCTX());
    expect(out.files).not.toContain(".gitignore");
  });

  it("reuses a branch left by an earlier attempt", async () => {
    const client = fakeGithub({
      createBranch: vi.fn(async () => {
        throw new Error("GitHub API error 422: Reference already exists");
      }),
    });
    const out = await handler(client)(INPUT, makeCTX());
    expect(out.reused).toBe(false);
    expect(client.openPullRequest).toHaveBeenCalled();
  });

  it("refuses a governance.toml that declares a different mode, before GitHub is reached", async () => {
    const client = fakeGithub();
    await expect(
      handler(client)(
        { ...INPUT, governanceToml: 'mode = "solo"\n' },
        makeCTX(),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "governance_toml_invalid",
    });
    expect(client.findOpenPullRequest).not.toHaveBeenCalled();
  });

  it("refuses a governance.toml the Context PR gate could not read", async () => {
    await expect(
      handler(fakeGithub())(
        { ...INPUT, governanceToml: "mode = [" },
        makeCTX(),
      ),
    ).rejects.toMatchObject({ reason: "governance_toml_invalid" });
  });

  it("refuses a workspace.toml that is not TOML", async () => {
    await expect(
      handler(fakeGithub())(
        { ...INPUT, workspaceToml: "schema = [" },
        makeCTX(),
      ),
    ).rejects.toMatchObject({ reason: "workspace_toml_invalid" });
  });

  it("refuses a repository that already has .oxagen/ on its production branch", async () => {
    const client = fakeGithub({
      getTree: vi.fn(async () => [".oxagen/workspace.toml"]),
    });
    await expect(handler(client)(INPUT, makeCTX())).rejects.toMatchObject({
      reason: "oxagen_tree_exists",
    });
    expect(client.createBranch).not.toHaveBeenCalled();
  });

  it("refuses when the production branch is gone from GitHub", async () => {
    await expect(
      handler(fakeGithub({ getBranch: vi.fn(async () => null) }))(
        INPUT,
        makeCTX(),
      ),
    ).rejects.toMatchObject({ reason: "production_branch_missing" });
  });

  it("refuses with repository_not_installed when the installation cannot see the repository", async () => {
    const client = fakeGithub({
      findOpenPullRequest: vi.fn(async () => {
        throw new Error("GitHub API error 404: Not Found");
      }),
    });
    await expect(handler(client)(INPUT, makeCTX())).rejects.toMatchObject({
      reason: "repository_not_installed",
    });
  });

  it("carries GitHub's refusal of a push as github_refused", async () => {
    const client = fakeGithub({
      putFile: vi.fn(async () => {
        throw new Error("GitHub API error 403: Resource not accessible");
      }),
    });
    await expect(handler(client)(INPUT, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "github_refused",
    });
    expect(client.openPullRequest).not.toHaveBeenCalled();
  });

  it("refuses with github_not_connected when no installation is attached", async () => {
    await expect(handler(null)(INPUT, makeCTX())).rejects.toMatchObject({
      reason: "github_not_connected",
    });
  });

  it("stops at the role gate", async () => {
    mocks.assertOrgRole.mockImplementation(async () => {
      throw new HandlerError({ code: "forbidden", reason: "role_required" });
    });
    const client = fakeGithub();
    await expect(handler(client)(INPUT, makeCTX())).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(client.findOpenPullRequest).not.toHaveBeenCalled();
  });
});
