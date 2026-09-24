// `get_published_steering`: the published .oxagen/ tree with every file's
// text, read from GitHub at one commit for `oxagen pull`.
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

import type { GitHubClient } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import {
  PUBLISHED_STEERING_MAX_FILES,
  publishedSteeringGet,
} from "@oxagen/oxagen/contracts/context.steering.published.get";
import {
  createPublishedSteeringGetHandler,
  mainRepoUnbound,
  mapWithConcurrency,
  publishedPaths,
  readMainBoundRepository,
} from "./context.steering.published.get";
import type { BoundRepository } from "./repository.bound";
import { makeCTX } from "./test-utils/fixtures";

const NOW = new Date("2026-09-24T10:00:00.000Z");

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

const LINKED: BoundRepository = {
  ...BOUND,
  role: "linked",
  bindingId: "rpb_0c2d",
  name: "docs",
  fullName: "acme/docs",
  providerRepositoryId: "43",
};

function fakeGithub(overrides: Partial<GitHubClient> = {}) {
  return {
    getRepoInfo: vi.fn(async (args: { repo: string }) => ({
      id: args.repo === "docs" ? "43" : "42",
      owner: "acme",
      name: args.repo,
      fullName: `acme/${args.repo}`,
      htmlUrl: `https://github.com/acme/${args.repo}`,
      defaultBranch: "main",
    })),
    getBranch: vi.fn(async () => ({ name: "main", sha: "abc123" })),
    getTree: vi.fn(async () => [
      "README.md",
      ".oxagen/workspace.toml",
      ".oxagen/workspace.json",
      ".oxagen/rules/governance.toml",
      ".oxagen/skills/review/SKILL.md",
    ]),
    getFileContent: vi.fn(
      async (args: { path: string }) => `text of ${args.path}`,
    ),
    ...overrides,
  } as unknown as GitHubClient;
}

function handler(
  client: GitHubClient | null,
  deps: {
    readMain?: () => Promise<BoundRepository>;
    readBound?: () => Promise<BoundRepository>;
  } = {},
) {
  return createPublishedSteeringGetHandler({
    github: { client: async () => client },
    readBound: vi.fn(deps.readBound ?? (async () => LINKED)),
    readMain: vi.fn(deps.readMain ?? (async () => BOUND)),
    now: () => NOW,
  });
}

describe("get_published_steering", () => {
  it("answers the main repository's .oxagen/ files at the head, sorted, without workspace.json", async () => {
    const client = fakeGithub();
    const out = await handler(client)({}, makeCTX());
    expect(out).toEqual({
      bindingId: "rpb_0a1b",
      role: "main",
      fullName: "acme/widgets",
      productionBranch: "main",
      head: "abc123",
      files: [
        {
          path: ".oxagen/rules/governance.toml",
          content: "text of .oxagen/rules/governance.toml",
        },
        {
          path: ".oxagen/skills/review/SKILL.md",
          content: "text of .oxagen/skills/review/SKILL.md",
        },
        {
          path: ".oxagen/workspace.toml",
          content: "text of .oxagen/workspace.toml",
        },
      ],
      readAt: NOW.toISOString(),
    });
    expect(publishedSteeringGet.output.safeParse(out).success).toBe(true);
    // The tree and every file are read at the head commit, never the branch.
    expect(client.getTree).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      ref: "abc123",
    });
    expect(client.getFileContent).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(client.getFileContent).mock.calls) {
      expect(call[0]).toMatchObject({ ref: "abc123" });
      expect(call[0].path).not.toBe(".oxagen/workspace.json");
    }
  });

  it("reads the named binding instead of the main repository when a bindingId is given", async () => {
    const readMain = vi.fn(async () => BOUND);
    const readBound = vi.fn(async () => LINKED);
    const client = fakeGithub();
    const out = await createPublishedSteeringGetHandler({
      github: { client: async () => client },
      readBound,
      readMain,
      now: () => NOW,
    })({ bindingId: "rpb_0c2d" }, makeCTX());
    expect(out.bindingId).toBe("rpb_0c2d");
    expect(out.role).toBe("linked");
    expect(readBound).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      "rpb_0c2d",
    );
    expect(readMain).not.toHaveBeenCalled();
  });

  it("answers head null and no files when the production branch is gone", async () => {
    const client = fakeGithub({ getBranch: vi.fn(async () => null) });
    const out = await handler(client)({}, makeCTX());
    expect(out.head).toBeNull();
    expect(out.files).toEqual([]);
    expect(client.getTree).not.toHaveBeenCalled();
  });

  it("leaves out a listed file GitHub answers 404 for", async () => {
    const client = fakeGithub({
      getTree: vi.fn(async () => [".oxagen/a.md", ".oxagen/b.md"]),
      getFileContent: vi.fn(async (args: { path: string }) =>
        args.path === ".oxagen/a.md" ? null : "b",
      ),
    });
    const out = await handler(client)({}, makeCTX());
    expect(out.files).toEqual([{ path: ".oxagen/b.md", content: "b" }]);
  });

  it("refuses main_repo_unbound when no bindingId is given and the workspace has no main repository", async () => {
    const client = fakeGithub();
    await expect(
      handler(client, {
        readMain: async () => {
          throw mainRepoUnbound();
        },
      })({}, makeCTX()),
    ).rejects.toMatchObject({ code: "conflict", reason: "main_repo_unbound" });
    expect(client.getRepoInfo).not.toHaveBeenCalled();
  });

  it("refuses github_not_connected when no installation is attached", async () => {
    await expect(handler(null)({}, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "github_not_connected",
    });
  });

  it("refuses repository_not_installed when the repository at those coordinates is another one", async () => {
    const client = fakeGithub({
      getRepoInfo: vi.fn(async () => ({
        id: "999",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets",
        htmlUrl: "https://github.com/acme/widgets",
        defaultBranch: "main",
      })),
    });
    const err = await handler(client)({}, makeCTX()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject({
      code: "not_found",
      reason: "repository_not_installed",
    });
    expect(client.getTree).not.toHaveBeenCalled();
  });

  it("refuses steering_too_large past the file cap and reads no file", async () => {
    const tree = Array.from(
      { length: PUBLISHED_STEERING_MAX_FILES + 1 },
      (_, i) => `.oxagen/records/r${i}.md`,
    );
    const client = fakeGithub({ getTree: vi.fn(async () => tree) });
    await expect(handler(client)({}, makeCTX())).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_too_large",
    });
    expect(client.getFileContent).not.toHaveBeenCalled();
  });
});

describe("publishedPaths", () => {
  it("keeps paths under .oxagen/ only, drops workspace.json, and sorts", () => {
    expect(
      publishedPaths([
        ".oxagen/z.md",
        "src/.oxagen/x.md",
        ".oxagen/workspace.json",
        ".oxagenx/y.md",
        ".oxagen/a.md",
      ]),
    ).toEqual([".oxagen/a.md", ".oxagen/z.md"]);
  });
});

describe("mapWithConcurrency", () => {
  it("keeps at most the limit in flight and answers in input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      8,
      async (n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return n * 2;
      },
    );
    expect(peak).toBe(8);
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
  });

  it("answers an empty list without calling fn", async () => {
    const fn = vi.fn(async () => 1);
    await expect(mapWithConcurrency([], 8, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("readMainBoundRepository", () => {
  /** A tx whose select chains answer `results` in order, one per read. */
  function wire(results: unknown[][]): void {
    const queue = [...results];
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: async () => queue.shift() ?? [],
    };
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ select: () => chain }),
    );
  }
  const scope = { orgId: "org_1", workspaceId: "ws_1" };
  const row = {
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

  it("answers the head whose role is main, through its current binding", async () => {
    wire([[{ bindingId: "rpb_0a1b" }], [row]]);
    await expect(readMainBoundRepository(scope)).resolves.toEqual(BOUND);
  });

  it("refuses main_repo_unbound when the workspace has no main head", async () => {
    wire([[]]);
    await expect(readMainBoundRepository(scope)).rejects.toMatchObject({
      code: "conflict",
      reason: "main_repo_unbound",
    });
  });

  it("refuses repository_host_unsupported for a GitLab main project", async () => {
    wire([[{ bindingId: "rpb_0a1b" }], [{ ...row, provider: "gitlab" }]]);
    await expect(readMainBoundRepository(scope)).rejects.toMatchObject({
      code: "conflict",
      reason: "repository_host_unsupported",
    });
  });
});
