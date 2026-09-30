// `get_repository_tree` (MC spec §10.1, §10.2): what a bound repository holds
// under `.oxagen/` on its production branch, read from GitHub at call time.
import { describe, expect, it, vi } from "vitest";
import type { GitHubClient } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import { repositoryTreeGet } from "@oxagen/oxagen/contracts/repository.tree.get";
import { schemaDirective } from "@oxagen/oxagen/steering-repo/schema-ids";
import type { BoundRepository } from "./repository.bound";
import {
  createRepositoryTreeGetHandler,
  declaredMode,
} from "./repository.tree.get";
import { makeCTX } from "./test-utils/fixtures";

/** A governance/v1 file with `mode`, as steering/governance.toml opens. */
const governanceV1 = (mode: string) =>
  `${schemaDirective("governance/v1")}\nschema = "governance/v1"\nmode = "${mode}"\n`;

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

function fakeGithub(overrides: Partial<GitHubClient> = {}) {
  const client = {
    getRepoInfo: vi.fn(async () => ({
      id: "42",
      owner: "acme",
      name: "widgets",
      fullName: "acme/widgets",
      htmlUrl: "https://github.com/acme/widgets",
      defaultBranch: "trunk",
    })),
    getBranch: vi.fn(async () => ({ name: "main", sha: "abc123" })),
    getTree: vi.fn(async () => [
      "README.md",
      ".oxagen/workspace.toml",
      ".oxagen/rules/governance.toml",
      ".oxagen/rules/.gitkeep",
    ]),
    getFileContent: vi.fn(async (args: { path: string }) =>
      args.path.endsWith("governance.toml")
        ? 'mode = "regulated"\n'
        : 'schema = "oxagen-workspace/v0.1"\n',
    ),
    findOpenPullRequest: vi.fn(async () => null),
    ...overrides,
  } as unknown as GitHubClient;
  return client;
}

function handler(client: GitHubClient | null, bound = BOUND) {
  return createRepositoryTreeGetHandler({
    github: { client: async () => client },
    readBound: async () => bound,
    now: () => NOW,
  });
}

describe("get_repository_tree", () => {
  it("answers the head, every .oxagen/ path, both files and the declared mode", async () => {
    const client = fakeGithub();
    const out = await handler(client)({ bindingId: "rpb_0a1b" }, makeCTX());
    expect(out).toEqual({
      bindingId: "rpb_0a1b",
      role: "main",
      fullName: "acme/widgets",
      productionBranch: "main",
      githubDefaultBranch: "trunk",
      head: "abc123",
      oxagen: {
        present: true,
        files: [
          ".oxagen/rules/.gitkeep",
          ".oxagen/rules/governance.toml",
          ".oxagen/workspace.toml",
        ],
      },
      steering: { present: false, files: [] },
      workspaceToml: 'schema = "oxagen-workspace/v0.1"\n',
      governancePath: ".oxagen/rules/governance.toml",
      governanceToml: 'mode = "regulated"\n',
      governanceMode: "regulated",
      initPullRequest: null,
      readAt: NOW.toISOString(),
    });
    expect(repositoryTreeGet.output.safeParse(out).success).toBe(true);
    // The tree is read on the production branch, never GitHub's default, and
    // at the head commit it answers, so every file comes from that commit.
    expect(client.getBranch).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      branch: "main",
    });
    expect(client.getTree).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      ref: "abc123",
    });
    expect(client.getFileContent).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      path: ".oxagen/workspace.toml",
      ref: "abc123",
    });
  });

  it("reads no file the tree does not carry, and reports the init pull request that waits", async () => {
    const client = fakeGithub({
      getTree: vi.fn(async () => ["README.md"]),
      findOpenPullRequest: vi.fn(async () => ({
        number: 9,
        htmlUrl: "https://github.com/acme/widgets/pull/9",
        body: "",
      })),
    });
    const out = await handler(client)({ bindingId: "rpb_0a1b" }, makeCTX());
    expect(out.oxagen).toEqual({ present: false, files: [] });
    expect(out.governanceMode).toBe("absent");
    expect(out.initPullRequest).toEqual({
      number: 9,
      htmlUrl: "https://github.com/acme/widgets/pull/9",
    });
    expect(client.getFileContent).not.toHaveBeenCalled();
    expect(client.findOpenPullRequest).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      head: "oxagen/init",
      base: "main",
    });
  });

  it("reads the mode a steering repository keeps in steering/governance.toml (#4821)", async () => {
    // Conversion moved the mode into steering/ and deleted the legacy file.
    const client = fakeGithub({
      getTree: vi.fn(async () => [
        "README.md",
        ".oxagen/workspace.toml",
        "steering/governance.toml",
        "steering/constraints/ctx.core.no-force-push.md",
      ]),
      getFileContent: vi.fn(async (args: { path: string }) =>
        args.path === "steering/governance.toml"
          ? governanceV1("solo")
          : 'schema = "oxagen-workspace/v0.1"\n',
      ),
    });
    const out = await handler(client)({ bindingId: "rpb_0a1b" }, makeCTX());
    expect(out.governancePath).toBe("steering/governance.toml");
    expect(out.governanceMode).toBe("solo");
    expect(out.steering).toEqual({
      present: true,
      files: [
        "steering/constraints/ctx.core.no-force-push.md",
        "steering/governance.toml",
      ],
    });
    expect(client.getFileContent).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      path: "steering/governance.toml",
      ref: "abc123",
    });
    expect(client.getFileContent).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: ".oxagen/rules/governance.toml" }),
    );
    expect(repositoryTreeGet.output.safeParse(out).success).toBe(true);
  });

  it("prefers the steering file when a half-converted repository holds both", async () => {
    const client = fakeGithub({
      getTree: vi.fn(async () => [
        ".oxagen/rules/governance.toml",
        "steering/governance.toml",
      ]),
      getFileContent: vi.fn(async (args: { path: string }) =>
        args.path === "steering/governance.toml"
          ? governanceV1("regulated")
          : 'mode = "solo"\n',
      ),
    });
    const out = await handler(client)({ bindingId: "rpb_0a1b" }, makeCTX());
    expect(out.governancePath).toBe("steering/governance.toml");
    expect(out.governanceMode).toBe("regulated");
  });

  it("reads a steering file governance/v1 refuses as invalid, whatever its mode line says", async () => {
    // readSteeringLayout and the merge queue refuse this file, so no mode is
    // in force, and the page must not report team.
    const client = fakeGithub({
      getTree: vi.fn(async () => ["steering/governance.toml"]),
      getFileContent: vi.fn(async () => 'mode = "team"\n'),
    });
    const out = await handler(client)({ bindingId: "rpb_0a1b" }, makeCTX());
    expect(out.governancePath).toBe("steering/governance.toml");
    expect(out.governanceMode).toBe("invalid");
  });

  it("answers head null and an empty tree when the production branch is gone from GitHub", async () => {
    const client = fakeGithub({ getBranch: vi.fn(async () => null) });
    const out = await handler(client)({ bindingId: "rpb_0a1b" }, makeCTX());
    expect(out.head).toBeNull();
    expect(out.oxagen.present).toBe(false);
    expect(out.steering.present).toBe(false);
    expect(out.governancePath).toBe(".oxagen/rules/governance.toml");
    expect(client.getTree).not.toHaveBeenCalled();
  });

  it("refuses with github_not_connected when no installation is attached", async () => {
    await expect(
      handler(null)({ bindingId: "rpb_0a1b" }, makeCTX()),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "github_not_connected",
    });
  });

  it("refuses with repository_not_installed when the installation cannot see the repository", async () => {
    const client = fakeGithub({
      getRepoInfo: vi.fn(async () => {
        throw new Error("GitHub API error 404: Not Found");
      }),
    });
    await expect(
      handler(client)({ bindingId: "rpb_0a1b" }, makeCTX()),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "repository_not_installed",
    });
  });

  it("refuses when the repository at those coordinates is a different one", async () => {
    // Deleted and re-created under the same owner/name: a new immutable id.
    const client = fakeGithub({
      getRepoInfo: vi.fn(async () => ({
        id: "99",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets",
        htmlUrl: "https://github.com/acme/widgets",
        defaultBranch: "trunk",
      })),
    } as unknown as Partial<GitHubClient>);
    await expect(
      handler(client)({ bindingId: "rpb_0a1b" }, makeCTX()),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "repository_not_installed",
    });
    expect(client.getTree).not.toHaveBeenCalled();
  });

  it("passes any other GitHub failure through unchanged", async () => {
    const client = fakeGithub({
      getRepoInfo: vi.fn(async () => {
        throw new Error("GitHub API error 502: Bad Gateway");
      }),
    });
    await expect(
      handler(client)({ bindingId: "rpb_0a1b" }, makeCTX()),
    ).rejects.toThrow("502");
  });

  it("names the bound head's connection, so a steering repository reads through its own app", async () => {
    const client = vi.fn(async () => fakeGithub());
    const h = createRepositoryTreeGetHandler({
      github: { client },
      readBound: async () => ({ ...BOUND, connectionId: "steering-conn" }),
      now: () => NOW,
    });
    const ctx = makeCTX();
    await h({ bindingId: "rpb_0a1b" }, ctx);
    expect(client).toHaveBeenCalledWith(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "steering-conn",
    );
  });

  it("passes the not-linked refusal from the read through", async () => {
    const h = createRepositoryTreeGetHandler({
      github: { client: async () => fakeGithub() },
      readBound: async () => {
        throw new HandlerError({
          code: "not_found",
          reason: "repository_not_linked",
        });
      },
      now: () => NOW,
    });
    await expect(h({ bindingId: "rpb_ffff" }, makeCTX())).rejects.toMatchObject(
      { reason: "repository_not_linked" },
    );
  });
});

describe("declaredMode", () => {
  it("reads absent, a known mode, and invalid for a file the gate would refuse", () => {
    expect(declaredMode(null)).toBe("absent");
    expect(declaredMode('mode = "solo"')).toBe("solo");
    expect(declaredMode('mode = "lax"')).toBe("invalid");
    expect(declaredMode("not toml [")).toBe("invalid");
  });

  it("reads a steering file as governance/v1 in full", () => {
    const valid = governanceV1("team");
    expect(declaredMode(valid, "steering")).toBe("team");
    // No schema line, an unknown key, and a rule the mode breaks.
    expect(declaredMode('mode = "team"\n', "steering")).toBe("invalid");
    expect(declaredMode(`${valid}colour = "gold"\n`, "steering")).toBe(
      "invalid",
    );
    expect(
      declaredMode(`${valid}\n[memory]\nauto_merge = true\n`, "steering"),
    ).toBe("invalid");
    // The legacy file still needs only its mode.
    expect(declaredMode('mode = "team"\n', "legacy")).toBe("team");
  });
});
