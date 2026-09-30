// webhook.test.ts: a push that changes a definition asks for its server's
// discovery (lane M10, #4682). The sweep store and requestDiscoveries are
// doubles, so each case checks which servers a push reaches.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoverySweepStore, OnChangeTarget } from "./store";

const entry = vi.hoisted(() => ({
  requestDiscoveries: vi.fn(
    async (targets: readonly unknown[], _trigger: string, _deps: unknown) =>
      targets.length,
  ),
}));
vi.mock("./entry", () => ({ requestDiscoveries: entry.requestDiscoveries }));

const defaultSweep = vi.hoisted(() => ({
  onChangeByRepo: vi.fn(async (_repo: string): Promise<unknown[]> => []),
}));
vi.mock("./store", () => ({ postgresDiscoverySweepStore: defaultSweep }));

import {
  githubDefinitionPush,
  gitlabDefinitionPush,
  pushedTargets,
  routeGithubDiscoveryPush,
  routeGitlabDiscoveryPush,
  type DefinitionPush,
  type GitlabProject,
} from "./webhook";

const SCOPE = { orgId: "org_1", workspaceId: "ws_1" };
// The project of the connection that authenticated a GitLab delivery.
const PROJECT: GitlabProject = {
  id: "42",
  path: "Platform/Billing",
  host: "gitlab.example.com",
};
const OTHER = { orgId: "org_1", workspaceId: "ws_2" };

function target(
  server: string,
  path: string,
  ref = "main",
  scope = SCOPE,
): OnChangeTarget {
  return { scope, server, path, ref };
}

function sweepDouble(targets: OnChangeTarget[]) {
  return {
    undiscovered: vi.fn(async () => []),
    dueDaily: vi.fn(async () => []),
    openPullRequests: vi.fn(async () => []),
    stalled: vi.fn(async () => []),
    registryMoved: vi.fn(async () => []),
    onChangeByRepo: vi.fn(async () => targets),
  } satisfies DiscoverySweepStore;
}

function githubPush(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    forced: false,
    deleted: false,
    repository: { full_name: "Acme/Payments-API" },
    commits: [
      { added: ["specs/stripe.yaml"], modified: [], removed: [] },
      { added: [], modified: ["README.md"], removed: ["old/github.graphql"] },
    ],
    ...overrides,
  };
}

function gitlabPush(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: "push",
    after: "5f1c0e7a9b3d2c4e6f8a0b1c2d3e4f5a6b7c8d9e",
    ref: "refs/heads/main",
    project: {
      id: 42,
      path_with_namespace: "Platform/Billing",
      web_url: "https://gitlab.example.com/Platform/Billing",
    },
    commits: [{ added: [], modified: ["api/billing.yaml"], removed: [] }],
    total_commits_count: 1,
    ...overrides,
  };
}

beforeEach(() => {
  entry.requestDiscoveries.mockImplementation(
    async (targets: readonly unknown[]) => targets.length,
  );
  defaultSweep.onChangeByRepo.mockImplementation(async () => []);
});

describe("githubDefinitionPush", () => {
  it("reads the repository, the ref, and every file the commits touched", () => {
    expect(githubDefinitionPush(githubPush())).toEqual({
      repo: "github.com/acme/payments-api",
      name: "main",
      ref: "refs/heads/main",
      files: new Set(["specs/stripe.yaml", "README.md", "old/github.graphql"]),
      complete: true,
    });
  });

  it("reads a tag push by the tag's name", () => {
    expect(githubDefinitionPush(githubPush({ ref: "refs/tags/v1.2.0" }))).toMatchObject(
      { name: "v1.2.0", ref: "refs/tags/v1.2.0" },
    );
  });

  it("marks a force push incomplete, since its commits may not list every file", () => {
    expect(githubDefinitionPush(githubPush({ forced: true }))?.complete).toBe(false);
  });

  it("skips a commit or a file it cannot read", () => {
    const push = githubDefinitionPush(
      githubPush({
        commits: [null, { added: "specs/a.yaml", modified: [7, "specs/b.yaml"] }],
      }),
    );

    expect(push?.files).toEqual(new Set(["specs/b.yaml"]));
  });

  it("reads a push with no commit list as one that touched no file", () => {
    expect(githubDefinitionPush(githubPush({ commits: undefined }))?.files).toEqual(
      new Set(),
    );
  });

  it.each([
    ["a deleted ref", { deleted: true }],
    ["a ref that is not a branch or a tag", { ref: "refs/pull/12/merge" }],
    ["no ref", { ref: undefined }],
    ["no repository name", { repository: {} }],
  ])("returns null for %s", (_case, overrides) => {
    expect(githubDefinitionPush(githubPush(overrides))).toBeNull();
  });

  it("returns null for a body that is not an object", () => {
    expect(githubDefinitionPush(null)).toBeNull();
    expect(githubDefinitionPush([githubPush()])).toBeNull();
  });
});

describe("gitlabDefinitionPush", () => {
  it("names the repository by the connection's host and path", () => {
    expect(gitlabDefinitionPush(gitlabPush(), PROJECT)).toEqual({
      repo: "gitlab.example.com/platform/billing",
      name: "main",
      ref: "refs/heads/main",
      files: new Set(["api/billing.yaml"]),
      complete: true,
    });
  });

  it("names gitlab.com when the connection names no host", () => {
    expect(
      gitlabDefinitionPush(gitlabPush(), { id: "42", path: "platform/billing" })
        ?.repo,
    ).toBe("gitlab.com/platform/billing");
  });

  it("takes the repository from the connection, never from the payload", () => {
    const forged = gitlabPush({
      project: {
        id: 42,
        path_with_namespace: "acme/payments-api",
        web_url: "https://github.com/acme/payments-api",
      },
    });

    expect(gitlabDefinitionPush(forged, PROJECT)?.repo).toBe(
      "gitlab.example.com/platform/billing",
    );
  });

  it("reads the project id from project_id when the project omits it", () => {
    const push = gitlabPush({ project: undefined, project_id: 42 });

    expect(gitlabDefinitionPush(push, PROJECT)?.repo).toBe(
      "gitlab.example.com/platform/billing",
    );
  });

  it("accepts a project id sent as a decimal string", () => {
    const push = gitlabPush({ project: { id: "42" } });

    expect(gitlabDefinitionPush(push, PROJECT)).not.toBeNull();
  });

  it("reads a tag push", () => {
    expect(
      gitlabDefinitionPush(
        gitlabPush({ object_kind: "tag_push", ref: "refs/tags/v2" }),
        PROJECT,
      ),
    ).toMatchObject({ name: "v2", ref: "refs/tags/v2" });
  });

  it("marks a push with more commits than the payload lists incomplete", () => {
    expect(
      gitlabDefinitionPush(gitlabPush({ total_commits_count: 25 }), PROJECT)
        ?.complete,
    ).toBe(false);
  });

  it("treats a push with no commit count as complete", () => {
    expect(
      gitlabDefinitionPush(
        gitlabPush({ total_commits_count: undefined }),
        PROJECT,
      )?.complete,
    ).toBe(true);
  });

  it.each([
    ["another kind of event", { object_kind: "merge_request" }],
    ["a deleted ref", { after: "0000000000000000000000000000000000000000" }],
    ["no after commit", { after: undefined }],
    ["a ref that is not a branch or a tag", { ref: "refs/merge-requests/4/head" }],
    ["no project id", { project: { path_with_namespace: "Platform/Billing" } }],
    ["another project's id", { project: { id: 7 } }],
    ["another project's id in project_id", { project: undefined, project_id: 7 }],
    ["a project id that is not an integer", { project: { id: 42.5 } }],
  ])("returns null for %s", (_case, overrides) => {
    expect(gitlabDefinitionPush(gitlabPush(overrides), PROJECT)).toBeNull();
  });

  it("returns null when the connection names no path", () => {
    expect(
      gitlabDefinitionPush(gitlabPush(), { ...PROJECT, path: "" }),
    ).toBeNull();
  });

  it("returns null for a body that is not an object", () => {
    expect(gitlabDefinitionPush("push", PROJECT)).toBeNull();
  });
});

describe("pushedTargets", () => {
  const push: DefinitionPush = {
    repo: "github.com/acme/payments-api",
    name: "main",
    ref: "refs/heads/main",
    files: new Set(["specs/stripe.yaml"]),
    complete: true,
  };

  it("keeps a target on the pushed ref whose definition the push changed", () => {
    const stripe = target("stripe", "specs/stripe.yaml");
    const full = target("stripe", "specs/stripe.yaml", "refs/heads/main", OTHER);

    expect(pushedTargets(push, [stripe, full])).toEqual([stripe, full]);
  });

  it("drops a target whose definition the push left alone", () => {
    expect(pushedTargets(push, [target("github", "specs/github.graphql")])).toEqual(
      [],
    );
  });

  it("drops a target on another ref", () => {
    expect(
      pushedTargets(push, [target("stripe", "specs/stripe.yaml", "release")]),
    ).toEqual([]);
  });

  it("keeps every target on the ref when the push may leave out a file", () => {
    const github = target("github", "specs/github.graphql");
    const release = target("stripe", "specs/stripe.yaml", "release");

    expect(pushedTargets({ ...push, complete: false }, [github, release])).toEqual(
      [github],
    );
  });
});

describe("routeGithubDiscoveryPush", () => {
  it("asks for a push discovery of each server whose definition changed", async () => {
    const sweep = sweepDouble([
      target("stripe", "specs/stripe.yaml"),
      target("stripe", "specs/stripe.yaml", "main", OTHER),
      target("github", "specs/github.graphql"),
    ]);
    const send = vi.fn(async () => {});

    await expect(
      routeGithubDiscoveryPush(githubPush(), { sweep, send }),
    ).resolves.toBe(2);

    expect(sweep.onChangeByRepo).toHaveBeenCalledWith("github.com/acme/payments-api");
    expect(entry.requestDiscoveries).toHaveBeenCalledWith(
      [
        { scope: SCOPE, server: "stripe" },
        { scope: OTHER, server: "stripe" },
      ],
      "push",
      { sweep, send },
    );
  });

  it("asks for nothing when the push changed no definition", async () => {
    const sweep = sweepDouble([target("github", "specs/github.graphql")]);

    await expect(routeGithubDiscoveryPush(githubPush(), { sweep })).resolves.toBe(0);

    expect(entry.requestDiscoveries).not.toHaveBeenCalled();
  });

  it("reads no store for a body it cannot read", async () => {
    const sweep = sweepDouble([target("stripe", "specs/stripe.yaml")]);

    await expect(
      routeGithubDiscoveryPush(githubPush({ deleted: true }), { sweep }),
    ).resolves.toBe(0);

    expect(sweep.onChangeByRepo).not.toHaveBeenCalled();
    expect(entry.requestDiscoveries).not.toHaveBeenCalled();
  });

  it("reads the Postgres sweep store by default", async () => {
    defaultSweep.onChangeByRepo.mockImplementation(async () => [
      target("stripe", "specs/stripe.yaml"),
    ]);

    await expect(routeGithubDiscoveryPush(githubPush())).resolves.toBe(1);

    expect(defaultSweep.onChangeByRepo).toHaveBeenCalledWith(
      "github.com/acme/payments-api",
    );
  });
});

describe("routeGitlabDiscoveryPush", () => {
  it("asks for a push discovery of each server whose definition changed", async () => {
    const sweep = sweepDouble([target("billing", "api/billing.yaml")]);

    await expect(
      routeGitlabDiscoveryPush(gitlabPush(), PROJECT, { sweep }),
    ).resolves.toBe(1);

    expect(sweep.onChangeByRepo).toHaveBeenCalledWith(
      "gitlab.example.com/platform/billing",
    );
    expect(entry.requestDiscoveries).toHaveBeenCalledWith(
      [{ scope: SCOPE, server: "billing" }],
      "push",
      { sweep },
    );
  });

  it("asks for nothing for another kind of event", async () => {
    const sweep = sweepDouble([target("billing", "api/billing.yaml")]);

    await expect(
      routeGitlabDiscoveryPush(gitlabPush({ object_kind: "note" }), PROJECT, {
        sweep,
      }),
    ).resolves.toBe(0);

    expect(sweep.onChangeByRepo).not.toHaveBeenCalled();
  });

  it("reads no store for a push that names another project", async () => {
    const sweep = sweepDouble([target("billing", "api/billing.yaml")]);

    await expect(
      routeGitlabDiscoveryPush(gitlabPush({ project: { id: 7 } }), PROJECT, {
        sweep,
      }),
    ).resolves.toBe(0);

    expect(sweep.onChangeByRepo).not.toHaveBeenCalled();
    expect(entry.requestDiscoveries).not.toHaveBeenCalled();
  });
});
