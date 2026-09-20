// repository.handlers.test.ts — the workspace-repository tools (MC spec §10.1):
// `list_repositories`, `link_repository`, `unlink_repository`, and the
// Repositories page's `get_repository_tree`, `set_production_branch` and
// `open_init_pr`.
//
// Same pattern as agent.handlers.test.ts: the kernel `invoke` and the context
// seam are mocked, and each tool must dispatch its own contract with the MCP
// surface and hand back the contract-parsed output.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

import linkTool, {
  metadata as linkMetadata,
  schema as linkSchema,
} from "./repository.link";
import listTool, { metadata as listMetadata } from "./repository.list";
import unlinkTool, {
  metadata as unlinkMetadata,
  schema as unlinkSchema,
} from "./repository.unlink";

describe("list_repositories tool", () => {
  it("is read-only and returns the workspace's repositories, main first", async () => {
    expect(listMetadata.name).toBe("list_repositories");
    expect(listMetadata.annotations?.readOnlyHint).toBe(true);
    const output = {
      repositories: [
        {
          bindingId: "rpb_0a",
          role: "main",
          owner: "acme",
          name: "platform",
          fullName: "acme/platform",
          defaultRef: "main",
          htmlUrl: "https://github.com/acme/platform",
          boundAt: "2026-09-18T00:00:00.000Z",
          connectionLive: true,
          events: "installed",
        },
      ],
    };
    mocks.invoke.mockResolvedValue(output);
    await expect(listTool({})).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "list_repositories",
      {},
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

describe("link_repository tool", () => {
  it("dispatches the link and answers the linked binding", async () => {
    expect(linkMetadata.name).toBe("link_repository");
    expect(linkMetadata.annotations?.readOnlyHint).toBe(false);
    const output = {
      bindingId: "rpb_0b",
      connectionId: "con_0b",
      fullName: "acme/shared-lib",
      defaultRef: "main",
      role: "linked",
      linkedAt: "2026-09-18T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(output);
    const args = {
      provider: "github" as const,
      owner: "acme",
      name: "shared-lib",
    };
    await expect(linkTool(args)).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "link_repository",
      args,
      fakeCtx,
      {
        surface: "mcp",
      },
    );
  });

  it("refuses a repository name GitHub would refuse (negative)", () => {
    expect(() => linkSchema.name.parse("shared lib")).toThrow();
  });
});

describe("unlink_repository tool", () => {
  it("dispatches the unlink by binding id", async () => {
    expect(unlinkMetadata.name).toBe("unlink_repository");
    const output = {
      bindingId: "rpb_0b",
      fullName: "acme/shared-lib",
      unlinkedAt: "2026-09-18T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(output);
    await expect(unlinkTool({ bindingId: "rpb_0b" })).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "unlink_repository",
      { bindingId: "rpb_0b" },
      fakeCtx,
      { surface: "mcp" },
    );
  });

  it("refuses an id that is not a binding id (negative)", () => {
    expect(() => unlinkSchema.bindingId.parse("con_0b")).toThrow();
  });
});

import treeTool, { metadata as treeMetadata } from "./repository.tree.get";
import branchTool, {
  metadata as branchMetadata,
  schema as branchSchema,
} from "./repository.production_branch.set";
import initTool, {
  metadata as initMetadata,
  schema as initSchema,
} from "./repository.init_pr.open";

describe("get_repository_tree tool", () => {
  it("is read-only and returns what the repository holds under .oxagen/", async () => {
    expect(treeMetadata.name).toBe("get_repository_tree");
    expect(treeMetadata.annotations?.readOnlyHint).toBe(true);
    const output = {
      bindingId: "rpb_0a",
      role: "main",
      fullName: "acme/platform",
      productionBranch: "main",
      githubDefaultBranch: "main",
      head: "abc123",
      oxagen: { present: true, files: [".oxagen/workspace.toml"] },
      workspaceToml: 'schema = "oxagen-workspace/v0.1"',
      governanceToml: null,
      governanceMode: "absent",
      initPullRequest: null,
      readAt: "2026-09-19T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(output);
    await expect(treeTool({ bindingId: "rpb_0a" })).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "get_repository_tree",
      { bindingId: "rpb_0a" },
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

describe("set_production_branch tool", () => {
  it("dispatches the branch and answers the binding it moved to", async () => {
    expect(branchMetadata.name).toBe("set_production_branch");
    expect(branchMetadata.annotations?.readOnlyHint).toBe(false);
    expect(branchSchema.branch.safeParse("has space").success).toBe(false);
    const output = {
      bindingId: "rpb_0b",
      fullName: "acme/platform",
      productionBranch: "release",
      previousBranch: "main",
      changed: true,
      setAt: "2026-09-19T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(output);
    await expect(
      branchTool({ bindingId: "rpb_0a", branch: "release" }),
    ).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith(
      "set_production_branch",
      { bindingId: "rpb_0a", branch: "release" },
      fakeCtx,
      { surface: "mcp" },
    );
  });
});

describe("open_init_pr tool", () => {
  it("dispatches the reviewed files and answers the pull request", async () => {
    expect(initMetadata.name).toBe("open_init_pr");
    expect(initSchema.governanceMode.safeParse("lax").success).toBe(false);
    const args = {
      bindingId: "rpb_0a",
      governanceMode: "team" as const,
      workspaceToml: 'schema = "oxagen-workspace/v0.1"',
      governanceToml: 'mode = "team"',
    };
    const output = {
      bindingId: "rpb_0a",
      fullName: "acme/platform",
      branch: "oxagen/init",
      base: "main",
      pullRequest: {
        number: 4,
        htmlUrl: "https://github.com/acme/platform/pull/4",
      },
      files: [".oxagen/workspace.toml"],
      reused: false,
      openedAt: "2026-09-19T00:00:00.000Z",
    };
    mocks.invoke.mockResolvedValue(output);
    await expect(initTool(args)).resolves.toEqual(output);
    expect(mocks.invoke).toHaveBeenCalledWith("open_init_pr", args, fakeCtx, {
      surface: "mcp",
    });
  });
});
