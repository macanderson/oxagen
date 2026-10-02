import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema } from "@oxagen/database";
import {
  GitHubApiError,
  type GitHubClient,
  type GitHubPrFile,
  type GitHubRest,
} from "@oxagen/github";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn(), assertSteeringCommit: vi.fn() }));

vi.mock("./steering-repo/diverged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./steering-repo/diverged")>()),
  assertGithubSteeringCommit: mocks.assertSteeringCommit,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

import {
  assertProductionBase,
  createSteeringGitHub,
  readGitHubConnection,
  standingApprovals,
  type SteeringConnection,
} from "./context.steering.github";

const SCOPE = { orgId: "org", workspaceId: "ws" };

/** Every column a drizzle predicate tree names, by its column name. */
function columnsIn(predicate: unknown, out = new Set<string>()): Set<string> {
  if (predicate === null || typeof predicate !== "object") return out;
  const node = predicate as Record<string, unknown>;
  if (typeof node["name"] === "string" && "table" in node) {
    out.add(node["name"]);
    return out;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const v of value) columnsIn(v, out);
    else if (value && typeof value === "object") columnsIn(value, out);
  }
  return out;
}

function fakeClient(over: Partial<GitHubClient> = {}): GitHubClient {
  return {
    getRepoInfo: async () => ({
      id: "84",
      owner: "a-intel",
      name: "platform",
      fullName: "a-intel/platform",
      htmlUrl: "",
      defaultBranch: "main",
    }),
    createBranch: async () => ({ ref: "refs/heads/x", sha: "s" }),
    putFile: async () => ({ commitSha: "c1", htmlUrl: "" }),
    openPullRequest: async () => ({ number: 1, htmlUrl: "u" }),
    getFileContent: async () => null,
    createCheckRun: async () => ({
      id: 1,
      htmlUrl: "https://github.com/x/runs/1",
    }),
    mergePullRequest: async () => ({ sha: "m", merged: true }),
    ...over,
  } as unknown as GitHubClient;
}

/** A bound repository whose approved ref matches whatever the fake reports. */
const BOUND: SteeringConnection = {
  source: "binding",
  owner: "a-intel",
  repo: "platform",
  approvedFullName: "a-intel/platform",
  approvedDefaultRef: "main",
};

function seam(
  client: GitHubClient,
  connection: SteeringConnection | null = BOUND,
) {
  const resolveToken = vi.fn(async () => "tok");
  const gh = createSteeringGitHub({
    readConnection: async () => connection,
    resolveToken,
    client: () => client,
  });
  return { gh, resolveToken };
}

describe("the GitHub seam", () => {
  it("refreshes the existing pull request and surfaces GitHub refusals", async () => {
    const updatePullRequest = vi
      .fn<GitHubClient["updatePullRequest"]>()
      .mockResolvedValueOnce({
        number: 17,
        htmlUrl: "https://github.com/a-intel/platform/pull/17",
      })
      .mockRejectedValueOnce(new Error("metadata refused"));
    const { gh } = seam(fakeClient({ updatePullRequest }));
    const repo = await gh.resolveRepository(SCOPE);
    const metadata = {
      number: 17,
      title: "Skill: release-notes",
      body: "New submitted bytes",
    };
    await expect(gh.updatePullRequest(repo, metadata)).resolves.toMatchObject({
      number: 17,
    });
    expect(updatePullRequest).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      ...metadata,
    });
    await expect(gh.updatePullRequest(repo, metadata)).rejects.toMatchObject({
      reason: "github_refused",
    });
  });

  it("refuses an existing proposal branch in exclusive mode without deleting it", async () => {
    const deleteBranch = vi.fn<GitHubClient["deleteBranch"]>();
    const { gh } = seam(
      fakeClient({
        createBranch: async () => {
          throw new Error("Reference already exists");
        },
        deleteBranch,
      }),
    );
    const repo = await gh.resolveRepository(SCOPE);
    await expect(
      gh.ensureBranch(repo, "skills/demo", "main", { exclusive: true }),
    ).rejects.toMatchObject({ reason: "proposal_branch_exists" });
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it("deletes omitted files only within the proposal's owned paths", async () => {
    const deleteFile = vi.fn<GitHubClient["deleteFile"]>(async () => undefined);
    const { gh } = seam(
      fakeClient({
        getTree: async () => [
          ".oxagen/skills/demo/SKILL.md",
          ".oxagen/skills/demo/old.md",
          ".oxagen/skills/demo/nested/old.md",
          ".oxagen/skills/demo-other/keep.md",
          "README.md",
        ],
        deleteFile,
      }),
    );
    const repo = await gh.resolveRepository(SCOPE);
    await gh.reconcileFiles(repo, {
      branch: "skills/demo",
      roots: [".oxagen/skills/demo"],
      files: [".oxagen/skills/demo/SKILL.md"],
    });
    expect(deleteFile.mock.calls.map(([args]) => args)).toEqual([
      expect.objectContaining({
        path: ".oxagen/skills/demo/old.md",
        branch: "skills/demo",
      }),
      expect.objectContaining({
        path: ".oxagen/skills/demo/nested/old.md",
        branch: "skills/demo",
      }),
    ]);
  });

  it("refuses reconciliation when the branch tree cannot be read", async () => {
    const { gh } = seam(
      fakeClient({
        getTree: async () => {
          throw new Error("GitHub unavailable");
        },
      }),
    );
    const repo = await gh.resolveRepository(SCOPE);
    await expect(
      gh.reconcileFiles(repo, {
        branch: "skills/demo",
        roots: [".oxagen/skills/demo"],
        files: [],
      }),
    ).rejects.toMatchObject({ reason: "github_refused" });
  });

  it("resolves the workspace's connected repository with its default branch, using the workspace's token", async () => {
    const { gh, resolveToken } = seam(fakeClient());
    const repo = await gh.resolveRepository(SCOPE);
    expect(repo).toEqual({
      provider: "github",
      owner: "a-intel",
      repo: "platform",
      fullName: "a-intel/platform",
      currentFullName: "a-intel/platform",
      defaultBranch: "main",
    });
    expect(resolveToken).toHaveBeenCalledWith(SCOPE);
  });

  /**
   * The production branch is the one the binding approved, not the one GitHub
   * reports today (#3233 review, P1).
   *
   * An admin who renames or switches the repository's default branch on GitHub
   * after the binding is written changes `getRepoInfo().defaultBranch` and
   * nothing else: the binding is immutable and the settings page still names
   * the approved ref.
   * If steering followed GitHub, every steering PR would be opened against,
   * compared against and merged into a branch no one approved — and
   * `assertProductionBase`, which compares a PR's base against this same
   * field, would agree with the wrong answer instead of catching it.
   */
  it("steers on the ref the binding approved, not the default branch GitHub reports now", async () => {
    const { gh } = seam(fakeClient(), {
      source: "binding",
      owner: "a-intel",
      repo: "platform",
      approvedFullName: "a-intel/platform",
      approvedDefaultRef: "release",
    });
    // The fake client reports "main" as the live default branch.
    const repo = await gh.resolveRepository(SCOPE);
    expect(repo.defaultBranch).toBe("release");
  });

  /**
   * The repository's NAME is an identifier too, and had the same defect one
   * field over.
   *
   * `open_steering_pr` dots `fullName` into the `set_id` at the top of every
   * steering record file and stores it as the proposal row's `repository`, so
   * it is what groups a workspace's records into one set. Taking it from live
   * `getRepoInfo()` meant renaming the repository on GitHub re-stamped every
   * later record with a different set id while the existing ones kept the old
   * one — two sets for one workspace, no error, nothing said. It also
   * disagreed with `get_main_repository`, which has always answered the
   * binding's frozen `provider_full_name`.
   */
  it("stamps records with the name the binding approved, not the one GitHub reports after a rename", async () => {
    // GitHub now calls it something else; the binding still says
    // `a-intel/platform`, which is what BOUND carries.
    const { gh } = seam(
      fakeClient({
        getRepoInfo: async () => ({
          fullName: "a-intel/core-platform",
          htmlUrl: "",
          defaultBranch: "main",
        }),
      } as unknown as Partial<GitHubClient>),
    );

    const repo = await gh.resolveRepository(SCOPE);

    // The identifier holds the approved name…
    expect(repo.fullName).toBe("a-intel/platform");
    // …and the live one is carried separately rather than thrown away, so the
    // divergence is observable instead of silent.
    expect(repo.currentFullName).toBe("a-intel/core-platform");
  });

  it("carries the live name as the current one when nothing has been renamed", async () => {
    const { gh } = seam(fakeClient());
    const repo = await gh.resolveRepository(SCOPE);
    // Equal is the normal case, and the fields are still distinct facts: this
    // pins that the current name is read from GitHub rather than copied off
    // the binding, which would make the rename test above pass for free.
    expect(repo.currentFullName).toBe("a-intel/platform");
    expect(repo.fullName).toBe(repo.currentFullName);
  });

  it("has no approved name to hold for a legacy connection, so both names are the live one", async () => {
    const { gh } = seam(fakeClient(), {
      source: "legacy_delivery_config",
      owner: "a-intel",
      repo: "platform",
    });
    const repo = await gh.resolveRepository(SCOPE);
    // Nothing was ever approved to disagree with — the same reason the legacy
    // arm resolves its ref from live GitHub.
    expect(repo.fullName).toBe("a-intel/platform");
    expect(repo.currentFullName).toBe("a-intel/platform");
  });

  it("refuses a steering PR retargeted at the branch GitHub now calls default", async () => {
    const { gh } = seam(fakeClient(), {
      source: "binding",
      owner: "a-intel",
      repo: "platform",
      approvedFullName: "a-intel/platform",
      approvedDefaultRef: "release",
    });
    const repo = await gh.resolveRepository(SCOPE);
    // GitHub reports the PR's base as "main" — the live default branch, and
    // not the approved one. The merge gate refuses it.
    expect(() =>
      assertProductionBase(repo, "main", "https://github.com/x/pull/9"),
    ).toThrow(/targets main; a steering PR merges only into release/);
    // And still admits one on the approved ref.
    expect(() =>
      assertProductionBase(repo, "release", "https://github.com/x/pull/9"),
    ).not.toThrow();
  });

  /**
   * A workspace connected through the legacy sources wizard has no binding and
   * therefore no approved ref, so live GitHub is the only source there is —
   * legitimate precisely because nothing was ever approved to disagree with.
   * Narrowing the bound case must not take this away.
   */
  it("uses the live default branch for a legacy connection, which has no approved ref", async () => {
    const { gh } = seam(fakeClient(), {
      source: "legacy_delivery_config",
      owner: "a-intel",
      repo: "platform",
    });
    const repo = await gh.resolveRepository(SCOPE);
    expect(repo).toEqual({
      provider: "github",
      owner: "a-intel",
      repo: "platform",
      fullName: "a-intel/platform",
      currentFullName: "a-intel/platform",
      defaultBranch: "main",
    });
  });

  it("refuses a workspace with no connected repository before minting a token", async () => {
    const { gh, resolveToken } = seam(fakeClient(), null);
    await expect(gh.resolveRepository(SCOPE)).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_repository_missing",
    });
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("reuses an existing branch and wraps any other GitHub refusal as github_refused", async () => {
    const createBranch = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("GitHub API error 422: Reference already exists"),
      )
      .mockRejectedValueOnce(new Error("GitHub API error 404: Not Found"));
    const { gh } = seam(fakeClient({ createBranch }));
    const repo = await gh.resolveRepository(SCOPE);
    await expect(
      gh.ensureBranch(repo, "context/x", "main"),
    ).resolves.toBeUndefined();
    await expect(
      gh.ensureBranch(repo, "context/x", "main"),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "github_refused",
      message: "GitHub API error 404: Not Found",
    });
  });

  it("creates a branch at the commit it is given in one call", async () => {
    const createBranch = vi
      .fn()
      .mockResolvedValue({ ref: "refs/heads/memory/x", sha: "planned" });
    const { gh } = seam(fakeClient({ createBranch }));
    const repo = await gh.resolveRepository(SCOPE);
    await gh.ensureBranch(repo, "memory/x", "main", {
      exclusive: true,
      at: "planned",
    });
    expect(createBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "memory/x",
        fromBranch: "main",
        fromSha: "planned",
      }),
    );
  });

  it("records a check run's url, answers null when the token cannot write checks, and refuses on anything else", async () => {
    const createCheckRun = vi
      .fn()
      .mockResolvedValueOnce({ id: 1, htmlUrl: "https://github.com/x/runs/1" })
      .mockRejectedValueOnce(
        new Error(
          "GitHub API error 403: Resource not accessible by integration",
        ),
      )
      .mockRejectedValueOnce(new Error("GitHub API error 500: boom"));
    const { gh } = seam(fakeClient({ createCheckRun }));
    const repo = await gh.resolveRepository(SCOPE);
    const args = {
      name: "n",
      headSha: "s",
      conclusion: "success" as const,
      title: "t",
      summary: "s",
      startedAt: "a",
      completedAt: "b",
    };
    expect(await gh.reportCheckRun(repo, args)).toBe(
      "https://github.com/x/runs/1",
    );
    expect(await gh.reportCheckRun(repo, args)).toBeNull();
    await expect(gh.reportCheckRun(repo, args)).rejects.toMatchObject({
      reason: "github_refused",
    });
  });

  it("merges with squash pinned to the head sha and surfaces GitHub's refusal", async () => {
    const mergePullRequest = vi
      .fn()
      .mockResolvedValueOnce({ sha: "m1", merged: true })
      .mockRejectedValueOnce(
        new Error(
          "GitHub API error 405: At least 1 approving review is required",
        ),
      );
    const { gh } = seam(fakeClient({ mergePullRequest }));
    const repo = await gh.resolveRepository(SCOPE);
    const args = { number: 519, commitTitle: "t", sha: "head1" };
    expect(await gh.mergePullRequest(repo, args)).toEqual({ sha: "m1" });
    expect(mergePullRequest).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      number: 519,
      mergeMethod: "squash",
      commitTitle: "t",
      sha: "head1",
    });
    await expect(gh.mergePullRequest(repo, args)).rejects.toMatchObject({
      reason: "github_refused",
      message: expect.stringContaining("approving review"),
    });
  });

  it("reads a PR's base, head and merge commit, and wraps a GitHub refusal", async () => {
    const getPullRequest = vi
      .fn()
      .mockResolvedValueOnce({
        baseRef: "main",
        headSha: "head2",
        state: "closed",
        merged: true,
        mergeCommitSha: "m2",
        mergedAt: "2026-09-15T09:16:40.000Z",
      })
      .mockRejectedValueOnce(new Error("GitHub API error 404: Not Found"));
    const { gh } = seam(fakeClient({ getPullRequest }));
    const repo = await gh.resolveRepository(SCOPE);
    expect(await gh.getPullRequest(repo, 519)).toEqual({
      baseRef: "main",
      headSha: "head2",
      // A merged pull request is closed; the repository sync reads `open`
      // to tell a PR still under review from one the host settled.
      open: false,
      merged: true,
      mergeCommitSha: "m2",
      mergedAt: new Date("2026-09-15T09:16:40.000Z"),
    });
    expect(getPullRequest).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      number: 519,
    });
    await expect(gh.getPullRequest(repo, 519)).rejects.toMatchObject({
      reason: "github_refused",
    });
  });

  it("names both paths of a rename among the changed paths, finds the open PR on a branch, and wraps a GitHub refusal", async () => {
    const compareCommits = vi
      .fn()
      .mockResolvedValueOnce([
        { path: ".oxagen/rules/ctx.a.toml", previousPath: null },
        { path: "docs/x.md", previousPath: ".oxagen/rules/governance.toml" },
      ])
      .mockRejectedValueOnce(new Error("GitHub API error 404: Not Found"));
    const findOpenPullRequest = vi
      .fn()
      .mockResolvedValueOnce({ number: 519, htmlUrl: "u", body: "b" });
    const { gh } = seam(fakeClient({ compareCommits, findOpenPullRequest }));
    const repo = await gh.resolveRepository(SCOPE);
    expect(await gh.changedPaths(repo, "main", "head1")).toEqual([
      ".oxagen/rules/ctx.a.toml",
      ".oxagen/rules/governance.toml",
      "docs/x.md",
    ]);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      base: "main",
      head: "head1",
    });
    await expect(gh.changedPaths(repo, "main", "head1")).rejects.toMatchObject({
      reason: "github_refused",
    });
    expect(
      await gh.findOpenPullRequest(repo, { head: "context/x", base: "main" }),
    ).toEqual({ number: 519, htmlUrl: "u", body: "b" });
    expect(findOpenPullRequest).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      head: "context/x",
      base: "main",
    });
  });

  it("closes a PR, deletes a branch, treats a branch already gone as deleted, and wraps any other refusal", async () => {
    const closePullRequest = vi.fn().mockResolvedValueOnce(undefined);
    const deleteBranch = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new Error("GitHub API error 422: Reference does not exist"),
      )
      .mockRejectedValueOnce(new Error("GitHub API error 403: Forbidden"));
    const { gh } = seam(fakeClient({ closePullRequest, deleteBranch }));
    const repo = await gh.resolveRepository(SCOPE);
    await expect(gh.closePullRequest(repo, 519)).resolves.toBeUndefined();
    expect(closePullRequest).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      number: 519,
    });
    await expect(gh.deleteBranch(repo, "context/x")).resolves.toBeUndefined();
    await expect(gh.deleteBranch(repo, "context/x")).resolves.toBeUndefined();
    await expect(gh.deleteBranch(repo, "context/x")).rejects.toMatchObject({
      reason: "github_refused",
      message: "GitHub API error 403: Forbidden",
    });
    expect(deleteBranch).toHaveBeenLastCalledWith({
      owner: "a-intel",
      repo: "platform",
      branch: "context/x",
    });
  });

  it("runs each workspace's calls under its own token when two workspaces resolve the same repository", async () => {
    const putA = vi.fn(async () => ({ commitSha: "ca", htmlUrl: "" }));
    const putB = vi.fn(async () => ({ commitSha: "cb", htmlUrl: "" }));
    const byToken: Record<string, GitHubClient> = {
      "tok-a": fakeClient({ putFile: putA }),
      "tok-b": fakeClient({ putFile: putB }),
    };
    const gh = createSteeringGitHub({
      readConnection: async () => BOUND,
      resolveToken: async (scope) => `tok-${scope.workspaceId}`,
      client: (token) => byToken[token]!,
    });
    const repoA = await gh.resolveRepository({
      orgId: "org",
      workspaceId: "a",
    });
    const repoB = await gh.resolveRepository({
      orgId: "org",
      workspaceId: "b",
    });
    expect(repoA).toEqual(repoB);
    const args = { path: "p", content: "c", message: "m", branch: "x" };
    expect(await gh.putFile(repoA, args)).toEqual({ commitSha: "ca" });
    expect(await gh.putFile(repoB, args)).toEqual({ commitSha: "cb" });
    expect(putA).toHaveBeenCalledTimes(1);
    expect(putB).toHaveBeenCalledTimes(1);
  });

  it("refuses to act on a repository it did not resolve", async () => {
    const { gh } = seam(fakeClient());
    await expect(
      gh.readFile(
        {
          provider: "github",
          owner: "o",
          repo: "r",
          fullName: "o/r",
          currentFullName: "o/r",
          defaultBranch: "main",
        },
        "p",
        "main",
      ),
    ).rejects.toThrow("no client for o/r");
  });
});

/**
 * Which repository the seam resolves as the workspace's main repo.
 *
 * The steering head and its binding version name the repository. The
 * connection a head hangs from names no repository. A read that looked only
 * at `delivery_config` answered null right after a head was written, and every
 * steering PR behaved as though no repository were connected.
 */
describe("the workspace's main repository", () => {
  const SELECT_SCOPE = { orgId: "org", workspaceId: "ws" };

  /**
   * The three reads `readGitHubConnection` can make, told apart by what each
   * one actually asks for rather than by the order it asks in:
   *
   *   `bound`       the joined read (heads → bindings → connections) — the only
   *                 chain that joins, so the join depth identifies it.
   *   `heads`       the unjoined read of `repository_binding_heads` — "does
   *                 this workspace declare a main repository at all".
   *   `connections` the unjoined read of `source_connections` — the legacy
   *                 sources-wizard fallback.
   *
   * The two unjoined reads take the same chain shape, so the fake dispatches
   * on the TABLE the code passed to `.from()`, which is the real Drizzle table
   * object.
   *
   * What this rig can and cannot prove. It discards every predicate, so these
   * tests pin the BRANCHING — which read the code makes, given what the read
   * before it answered — and what the code carries off a row into its answer.
   * The status filter on the joined read is asserted nowhere here and cannot
   * be; that would need a real Postgres.
   *
   * It DOES apply the column projection (#3265 review, cubic P2). Until it
   * did, it handed every fixture row back wholesale, so a test asserting that
   * `approvedDefaultRef` reaches the answer passed whether or not the query
   * selected the column — it proved only that the function carried a field off
   * a row it was given. Projecting by the aliases the caller asked for closes
   * that: drop a column from the `.select()` and the row the handler reads no
   * longer carries it. What remains out of reach is the predicates, not the
   * projection.
   *
   * Returns a counter of the unjoined reads so a test can assert a read was
   * never reached at all, not merely that its rows went unused. It also keeps
   * the joined read's predicate, so a test can assert which COLUMNS it names.
   * That shows a filter is present. It does not show what the filter matches.
   */
  function db(opts: {
    bound?: unknown[];
    heads?: unknown[];
    connections?: unknown[];
  }): {
    readonly headReads: number;
    readonly connectionReads: number;
    readonly boundWhere: unknown;
  } {
    const counts = {
      headReads: 0,
      connectionReads: 0,
      boundWhere: undefined as unknown,
    };
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: (projection?: Record<string, unknown>) => {
            // Apply the projection the caller asked for, keyed by its ALIASES
            // — which is what a fixture row is keyed by. A column the query
            // stops selecting is therefore absent from the row the handler
            // reads, so dropping it fails the test that depends on it instead
            // of passing on a fixture the rig handed back wholesale.
            const project = (rows: unknown[]): unknown[] =>
              projection === undefined
                ? rows
                : rows.map((row) => {
                    const source = row as Record<string, unknown>;
                    return Object.fromEntries(
                      Object.keys(projection)
                        .filter((alias) => alias in source)
                        .map((alias) => [alias, source[alias]]),
                    );
                  });
            return {
              from: (table: unknown) => ({
                innerJoin: () => ({
                  innerJoin: () => ({
                    where: (predicate: unknown) => {
                      counts.boundWhere = predicate;
                      return {
                        limit: async () => project(opts.bound ?? []),
                      };
                    },
                  }),
                }),
                where: () => ({
                  limit: async () => {
                    if (table === schema.repositoryBindingHeads) {
                      counts.headReads += 1;
                      return project(opts.heads ?? []);
                    }
                    counts.connectionReads += 1;
                    return project(opts.connections ?? []);
                  },
                }),
              }),
            };
          },
        }),
    );
    return counts;
  }

  it("resolves the repository and the approved ref the binding recorded, on a connection that names none", async () => {
    db({
      bound: [
        {
          owner: "Acme",
          repo: "Widgets",
          approvedFullName: "Acme/Widgets",
          approvedDefaultRef: "release",
        },
      ],
      connections: [{ deliveryConfig: { installationId: "555" } }],
    });
    await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toEqual({
      source: "binding",
      owner: "Acme",
      repo: "Widgets",
      approvedFullName: "Acme/Widgets",
      approvedDefaultRef: "release",
    });
  });

  // A `linked` head, or one the exclusivity migration demoted, is a
  // repository the workspace can see and is not steered by. Steering PRs and
  // `get_steering_freshness` both resolve through this read, so an unordered
  // `limit(1)` without the filter could steer either one by a linked head.
  // Kept on purpose (#3340): Mac decided on 2026-10-01 that a linked code
  // repository never receives steering PRs, so this read stays pinned to the
  // steering head.
  it("names the head's role in the joined read, so only a steering head steers", async () => {
    const counts = db({ bound: [] });
    await readGitHubConnection(SELECT_SCOPE);
    expect(columnsIn(counts.boundWhere).has("role")).toBe(true);
  });

  it("prefers the binding over a legacy connection's ingestion sync target", async () => {
    db({
      bound: [
        {
          owner: "Acme",
          repo: "Widgets",
          approvedFullName: "Acme/Widgets",
          approvedDefaultRef: "release",
        },
      ],
      connections: [{ deliveryConfig: { owner: "a-intel", repo: "platform" } }],
    });
    await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toEqual({
      source: "binding",
      owner: "Acme",
      repo: "Widgets",
      approvedFullName: "Acme/Widgets",
      approvedDefaultRef: "release",
    });
  });

  it("falls back to the legacy sources wizard's connection when no binding exists", async () => {
    db({
      bound: [],
      connections: [{ deliveryConfig: { owner: "a-intel", repo: "platform" } }],
    });
    await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toEqual({
      source: "legacy_delivery_config",
      owner: "a-intel",
      repo: "platform",
    });
  });

  /**
   * Also the shape of the reconnect state (#3233): when the head names a
   * connection that has been deleted, the join above yields nothing, and the
   * replacement connection the install callback inserted carries an
   * installation id and no owner/repo — so steering resolves null with a
   * repository still bound. No capability moves the head onto the live
   * connection yet (#4637).
   */
  it("answers null when neither a binding nor a configured connection names a repository", async () => {
    db({
      bound: [],
      connections: [{ deliveryConfig: { installationId: "5" } }],
    });
    await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toBeNull();
    db({ bound: [], connections: [] });
    await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toBeNull();
  });

  /**
   * The legacy fallback is for workspaces that never bound anything (#3233
   * review, P1).
   *
   * The joined read misses for two different reasons — no head was ever
   * written, or a head exists and the connection it was bound through is
   * retired — and the join cannot tell them apart. Treating the second as the
   * first hands steering and every steering PR to whatever repository a
   * still-connected legacy sources connection happens to name in its ingestion
   * `delivery_config`, which is an UNRELATED repository: `owner`/`repo` there
   * mean the sync target, not the main repo. Writing steering into the wrong
   * repository is worse than steering being off, so the head's existence is
   * read explicitly and a workspace that has one answers null.
   */
  // §10.1 / ADR-099: a workspace may hold `linked` heads beside its one
  // `main`. Steering resolves through THE main repository, so both reads —
  // the joined one and the bare "does a head exist" one — pin the role. This
  // rig discards predicates everywhere else; here they are captured and
  // compiled, because a reader that ignored the column would write steering
  // into a linked repository. repository.pg.test.ts proves the same with both
  // heads present in Postgres.
  it("asks only for a steering head, on both reads", async () => {
    const captured: SQL[] = [];
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({
              innerJoin: () => ({
                innerJoin: () => ({
                  where: (cond: SQL) => {
                    captured.push(cond);
                    return { limit: async () => [] };
                  },
                }),
              }),
              where: (cond: SQL) => {
                captured.push(cond);
                return { limit: async () => [] };
              },
            }),
          }),
        }),
    );
    await readGitHubConnection(SELECT_SCOPE);
    // The joined read, the heads read, then the legacy connection read.
    expect(captured.length).toBeGreaterThanOrEqual(2);
    const dialect = new PgDialect();
    for (const cond of captured.slice(0, 2)) {
      const query = dialect.sqlToQuery(cond);
      expect(query.sql).toMatch(/"role" in \(\$\d+\)/);
      expect(query.params).toContain("steering");
    }
  });

  describe("a bound head whose connection is unusable is not a workspace with no binding", () => {
    it("answers null rather than the legacy repo when a head exists and the join missed", async () => {
      const counts = db({
        // The joined read misses: the head's connection is retired, so the
        // status filter drops the row.
        bound: [],
        // The head itself is still there — the binding rows outlive the
        // connection.
        heads: [{ id: "head-1" }],
        // And an unrelated legacy sources connection is still connected,
        // naming its ingestion sync target.
        connections: [
          { deliveryConfig: { owner: "a-intel", repo: "platform" } },
        ],
      });

      await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toBeNull();
      // Not merely unused — the fallback read is never made.
      expect(counts.headReads).toBe(1);
      expect(counts.connectionReads).toBe(0);
    });

    it("still falls back for a workspace that never bound anything", async () => {
      // The reason the fallback exists: connected through the legacy sources
      // wizard, which populates owner/repo at its mappings step and writes no
      // binding. Narrowing must not take this away.
      const counts = db({
        bound: [],
        heads: [],
        connections: [
          { deliveryConfig: { owner: "a-intel", repo: "platform" } },
        ],
      });

      await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toEqual({
        source: "legacy_delivery_config",
        owner: "a-intel",
        repo: "platform",
      });
      expect(counts.headReads).toBe(1);
      expect(counts.connectionReads).toBe(1);
    });

    it("answers the bound repository without asking either follow-up question", async () => {
      // The joined read hit, so there is nothing to disambiguate.
      const counts = db({
        bound: [
          {
            owner: "Acme",
            repo: "Widgets",
            approvedFullName: "Acme/Widgets",
            approvedDefaultRef: "release",
          },
        ],
        heads: [{ id: "head-1" }],
        connections: [
          { deliveryConfig: { owner: "a-intel", repo: "platform" } },
        ],
      });

      await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toEqual({
        source: "binding",
        owner: "Acme",
        repo: "Widgets",
        approvedFullName: "Acme/Widgets",
        approvedDefaultRef: "release",
      });
      expect(counts.headReads).toBe(0);
      expect(counts.connectionReads).toBe(0);
    });
  });

  // The steering repo provisioner binds its repository through a
  // `github_steering` connection, and only the Oxagen GitHub App can reach
  // that repository. The read carries the installation id so the seam can
  // mint that app's token.
  describe("a steering head the provisioner bound", () => {
    const PROVISIONED = {
      owner: "acme",
      repo: "acme-steering",
      approvedFullName: "acme/acme-steering",
      approvedDefaultRef: "main",
      connectorId: "github_steering",
    };

    it("carries the Oxagen GitHub App installation id", async () => {
      db({
        bound: [
          {
            ...PROVISIONED,
            deliveryConfig: { installationId: 4242, owner: "acme" },
          },
        ],
      });
      await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toEqual({
        source: "binding",
        owner: "acme",
        repo: "acme-steering",
        approvedFullName: "acme/acme-steering",
        approvedDefaultRef: "main",
        steeringInstallationId: 4242,
      });
    });

    it("reads an installation id stored as a string of digits", async () => {
      db({
        bound: [{ ...PROVISIONED, deliveryConfig: { installationId: "4242" } }],
      });
      await expect(readGitHubConnection(SELECT_SCOPE)).resolves.toMatchObject({
        steeringInstallationId: 4242,
      });
    });

    it.each([
      ["no delivery config", null],
      ["no installation id", { owner: "acme" }],
      ["a zero installation id", { installationId: 0 }],
      ["an installation id that is not a number", { installationId: "abc" }],
    ])("refuses a steering head with %s", async (_label, deliveryConfig) => {
      db({ bound: [{ ...PROVISIONED, deliveryConfig }] });
      await expect(readGitHubConnection(SELECT_SCOPE)).rejects.toMatchObject({
        code: "conflict",
        reason: "steering_installation_missing",
      });
    });

    it("leaves a head on the workspace's own GitHub connection alone", async () => {
      db({
        bound: [
          {
            ...PROVISIONED,
            connectorId: "github",
            deliveryConfig: { installationId: "555" },
          },
        ],
      });
      const answer = await readGitHubConnection(SELECT_SCOPE);
      expect(answer).not.toHaveProperty("steeringInstallationId");
    });
  });
});

describe("the GitHub seam's token for a provisioned steering repository", () => {
  const PROVISIONED_BOUND: SteeringConnection = {
    source: "binding",
    owner: "a-intel",
    repo: "platform",
    approvedFullName: "a-intel/platform",
    approvedDefaultRef: "main",
    steeringInstallationId: 4242,
  };

  it("verifies provisioned repository commits from binding metadata", async () => {
    vi.stubEnv("GITHUB_APP_ID", "71");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "test-key");
    vi.stubEnv("GITHUB_APP_SLUG", "oxagen-steering");
    try {
      mocks.assertSteeringCommit.mockResolvedValueOnce(undefined);
      const client = fakeClient();
      const request = vi.fn().mockResolvedValue({ status: 200, data: { verified: true } });
      const gh = createSteeringGitHub({
        readConnection: async () => PROVISIONED_BOUND,
        resolveToken: async () => "workspace-token",
        steeringToken: async () => "steering-token",
        client: () => client,
        rest: () => ({ request }),
      });
      const repo = await gh.resolveRepository(SCOPE);
      expect(repo.requiresSteeringProvenance).toBe(true);
      await gh.assertSteeringCommit?.(repo, "captured-sha");
      expect(mocks.assertSteeringCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: { owner: "a-intel", name: "platform", id: 84 },
          defaultBranch: "main",
          app: { id: 71, slug: "oxagen-steering", symbol: "oxagen-steering" },
        }),
        "captured-sha",
      );
      const target = mocks.assertSteeringCommit.mock.calls.at(-1)?.[0] as
        import("./steering-repo/diverged").GithubHistoryTarget | undefined;
      if (!target) throw new Error("The verifier received no target");
      await expect(target.rest.request("GET", "/proof")).resolves.toEqual({
        status: 200, data: { verified: true }, message: null,
      });
      request.mockRejectedValueOnce(new GitHubApiError(404, "missing"));
      await expect(target.rest.request("GET", "/proof", undefined, [404])).resolves.toEqual({
        status: 404, data: null, message: "GitHub API error 404: missing",
      });
      request.mockRejectedValueOnce(new Error("GitHub unavailable"));
      await expect(target.rest.request("GET", "/proof")).rejects.toThrow("GitHub unavailable");
      mocks.assertSteeringCommit.mockRejectedValueOnce(new Error("provenance unavailable"));
      await expect(gh.assertSteeringCommit?.(repo, "other-sha")).rejects.toThrow("provenance unavailable");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses provenance checks when the app configuration is missing", async () => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("GITHUB_APP_SLUG", "");
    try {
      const gh = createSteeringGitHub({
        readConnection: async () => PROVISIONED_BOUND,
        resolveToken: async () => "workspace-token",
        steeringToken: async () => "steering-token",
        client: () => fakeClient(),
      });
      const repo = await gh.resolveRepository(SCOPE);
      await expect(gh.assertSteeringCommit?.(repo, "captured-sha")).rejects.toMatchObject({
        reason: "steering_app_unconfigured",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("leaves legacy repository commits outside the provisioned provenance gate", async () => {
    const { gh } = seam(fakeClient());
    const repo = await gh.resolveRepository(SCOPE);
    const before = mocks.assertSteeringCommit.mock.calls.length;
    await expect(gh.assertSteeringCommit?.(repo, "captured-sha")).resolves.toBeUndefined();
    expect(mocks.assertSteeringCommit.mock.calls).toHaveLength(before);
  });

  it("mints the Oxagen GitHub App token and never asks for the workspace's", async () => {
    const resolveToken = vi.fn(async () => "workspace-tok");
    const steeringToken = vi.fn(async () => "steering-tok");
    const client = vi.fn(() => fakeClient());
    const gh = createSteeringGitHub({
      readConnection: async () => PROVISIONED_BOUND,
      resolveToken,
      steeringToken,
      client,
    });
    await gh.resolveRepository(SCOPE);
    expect(steeringToken).toHaveBeenCalledWith(4242);
    expect(resolveToken).not.toHaveBeenCalled();
    expect(client).toHaveBeenCalledWith("steering-tok");
  });

  it("uses the workspace's token for a head with no steering installation", async () => {
    const resolveToken = vi.fn(async () => "workspace-tok");
    const steeringToken = vi.fn(async () => "steering-tok");
    const client = vi.fn(() => fakeClient());
    const gh = createSteeringGitHub({
      readConnection: async () => BOUND,
      resolveToken,
      steeringToken,
      client,
    });
    await gh.resolveRepository(SCOPE);
    expect(resolveToken).toHaveBeenCalledWith(SCOPE);
    expect(steeringToken).not.toHaveBeenCalled();
    expect(client).toHaveBeenCalledWith("workspace-tok");
  });

  it("refuses by default when the deployment has no Oxagen GitHub App", async () => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "");
    vi.stubEnv("GITHUB_APP_SLUG", "");
    try {
      const resolveToken = vi.fn(async () => "workspace-tok");
      const gh = createSteeringGitHub({
        readConnection: async () => PROVISIONED_BOUND,
        resolveToken,
        client: () => fakeClient(),
      });
      await expect(gh.resolveRepository(SCOPE)).rejects.toMatchObject({
        code: "conflict",
        reason: "steering_app_unconfigured",
      });
      expect(resolveToken).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the GitHub seam's merge-queue calls", () => {
  const REPO_PATH = "/repos/a-intel/platform";
  type Route = (body: unknown) => unknown;

  /**
   * A seam whose plain REST calls answer from `routes`, keyed by
   * `METHOD path`. A route answers its data, or throws what GitHub would.
   */
  async function restSeam(
    routes: Record<string, Route>,
    client: GitHubClient = fakeClient(),
    sleep: (ms: number) => Promise<void> = async () => {},
  ) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const rest: GitHubRest = {
      async request<T>(method: string, path: string, body?: unknown) {
        calls.push({ method, path, ...(body === undefined ? {} : { body }) });
        const route = routes[`${method} ${path}`];
        if (!route) throw new GitHubApiError(404, `no route ${method} ${path}`);
        const data = route(body);
        // GitHub answers a create 201 and a no-op 204.
        const status =
          data === undefined ? 204 : method === "POST" ? 201 : 200;
        return { status, data: data as T };
      },
    };
    const linkAccount = vi.fn(async (_provider: string, id: string) =>
      id === "11" ? "user-11" : null,
    );
    const gh = createSteeringGitHub({
      readConnection: async () => BOUND,
      resolveToken: async () => "tok",
      client: () => client,
      rest: () => rest,
      linkAccount,
      sleep,
    });
    const repo = await gh.resolveRepository(SCOPE);
    return { gh, repo, calls, linkAccount };
  }

  const refuse = (status: number, message: string): Route => () => {
    throw new GitHubApiError(status, message);
  };

  it("merges through REST with the trailers in the commit body, pinned to the head", async () => {
    const mergePullRequest = vi.fn();
    const { gh, repo, calls } = await restSeam(
      { [`PUT ${REPO_PATH}/pulls/7/merge`]: () => ({ sha: "sq1" }) },
      fakeClient({ mergePullRequest }),
    );
    await expect(
      gh.mergePullRequest(repo, {
        number: 7,
        commitTitle: "[steering] rule",
        sha: "h1",
        commitMessage: "Oxagen-Version: 3",
      }),
    ).resolves.toEqual({ sha: "sq1" });
    expect(calls[0]!.body).toEqual({
      merge_method: "squash",
      commit_title: "[steering] rule",
      commit_message: "Oxagen-Version: 3",
      sha: "h1",
    });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("wraps a refused REST merge as github_refused", async () => {
    const { gh, repo, calls } = await restSeam({
      [`PUT ${REPO_PATH}/pulls/7/merge`]: refuse(405, "Head branch was modified"),
    });
    await expect(
      gh.mergePullRequest(repo, {
        number: 7,
        commitTitle: "t",
        sha: "h1",
        commitMessage: "m",
      }),
    ).rejects.toMatchObject({
      reason: "github_refused",
      message: expect.stringContaining("Head branch was modified"),
    });
    // Only GitHub's two settling refusals wait; any other answers at once.
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
  });

  describe("a merge GitHub refuses while it checks the new head (#5157)", () => {
    const MERGE = `PUT ${REPO_PATH}/pulls/7/merge`;
    const PULL = `GET ${REPO_PATH}/pulls/7`;
    const BASE_REF = `GET ${REPO_PATH}/git/ref/heads/main`;
    const args = { number: 7, commitTitle: "t", sha: "h1", commitMessage: "m" };
    const pull = (mergeable: boolean | null, sha = "h1", state = "open") => ({
      state,
      mergeable,
      head: { sha },
      base: { ref: "main" },
    });
    const baseAt = (sha: string): Route => () => ({ object: { sha } });
    /** Answers each call from `answers` in turn, and the last one after that. */
    const inTurn = (...answers: Route[]): Route => {
      let call = 0;
      return (body) => answers[Math.min(call++, answers.length - 1)]!(body);
    };

    it("reads the pull request until GitHub knows, then merges again", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: inTurn(refuse(405, "Pull Request is not mergeable"), () => ({
          sha: "sq2",
        })),
        [PULL]: inTurn(
          () => pull(null),
          () => pull(true),
        ),
      });
      await expect(gh.mergePullRequest(repo, args)).resolves.toEqual({
        sha: "sq2",
      });
      expect(calls.map((c) => c.method)).toEqual(["PUT", "GET", "GET", "PUT"]);
    });

    it("keeps GitHub's refusal when GitHub says the pull request can't merge", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: refuse(405, "Pull Request is not mergeable"),
        [PULL]: () => pull(false),
      });
      await expect(gh.mergePullRequest(repo, args)).rejects.toMatchObject({
        reason: "github_refused",
        message: expect.stringContaining("not mergeable"),
      });
      expect(calls.map((c) => c.method)).toEqual(["PUT", "GET"]);
    });

    it("keeps GitHub's refusal when the pull request closed", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: refuse(405, "Pull Request is not mergeable"),
        [PULL]: () => pull(null, "h1", "closed"),
      });
      await expect(gh.mergePullRequest(repo, args)).rejects.toMatchObject({
        reason: "github_refused",
      });
      expect(calls.map((c) => c.method)).toEqual(["PUT", "GET"]);
    });

    it("keeps GitHub's refusal when the head never reaches the pinned commit", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: refuse(405, "Pull Request is not mergeable"),
        [PULL]: () => pull(true, "h2"),
      });
      await expect(gh.mergePullRequest(repo, args)).rejects.toMatchObject({
        reason: "github_refused",
      });
      // A head someone pushed past never reaches h1, so the reads run out.
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(15);
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    });

    it("waits for GitHub to move the head to the pinned stamp after 'Head branch was modified'", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: inTurn(
          refuse(409, "Head branch was modified. Review and try the merge again."),
          () => ({ sha: "sq5" }),
        ),
        // GitHub still names the commit before the stamp, then catches up.
        [PULL]: inTurn(
          () => pull(true, "h0"),
          () => pull(null, "h1"),
          () => pull(true, "h1"),
        ),
        [BASE_REF]: baseAt("b1"),
      });
      await expect(
        gh.mergePullRequest(repo, { ...args, base: "b1" }),
      ).resolves.toEqual({ sha: "sq5" });
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        MERGE,
        PULL,
        PULL,
        PULL,
        BASE_REF,
        MERGE,
      ]);
    });

    it("keeps GitHub's refusal when reading the pull request fails", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: refuse(405, "Pull Request is not mergeable"),
        [PULL]: refuse(502, "Bad Gateway"),
      });
      await expect(gh.mergePullRequest(repo, args)).rejects.toMatchObject({
        reason: "github_refused",
        message: expect.stringContaining("not mergeable"),
      });
      expect(calls.map((c) => c.method)).toEqual(["PUT", "GET"]);
    });

    it("stops reading after 15 reads with no answer", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: refuse(405, "Pull Request is not mergeable"),
        [PULL]: () => pull(null),
      });
      await expect(gh.mergePullRequest(repo, args)).rejects.toMatchObject({
        reason: "github_refused",
      });
      expect(calls.filter((c) => c.method === "GET")).toHaveLength(15);
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    });

    it("merges at most four times", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: refuse(405, "Pull Request is not mergeable"),
        [PULL]: () => pull(true),
      });
      await expect(gh.mergePullRequest(repo, args)).rejects.toMatchObject({
        reason: "github_refused",
      });
      expect(calls.map((c) => c.method)).toEqual([
        "PUT",
        "GET",
        "PUT",
        "GET",
        "PUT",
        "GET",
        "PUT",
      ]);
    });

    it("waits one interval longer before each later retry", async () => {
      const sleep = vi.fn(async (_ms: number) => {});
      const { gh, repo } = await restSeam(
        {
          [MERGE]: inTurn(
            refuse(405, "Pull Request is not mergeable"),
            refuse(405, "Pull Request is not mergeable"),
            () => ({ sha: "sq3" }),
          ),
          [PULL]: () => pull(true),
        },
        fakeClient(),
        sleep,
      );
      await expect(gh.mergePullRequest(repo, args)).resolves.toEqual({
        sha: "sq3",
      });
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
    });

    it("retries 'Base branch was modified' while the base is still the checked commit", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: inTurn(
          refuse(405, "Base branch was modified. Review and try the merge again."),
          () => ({ sha: "sq4" }),
        ),
        [PULL]: () => pull(true),
        [BASE_REF]: baseAt("b1"),
      });
      await expect(
        gh.mergePullRequest(repo, { ...args, base: "b1" }),
      ).resolves.toEqual({ sha: "sq4" });
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        MERGE,
        PULL,
        BASE_REF,
        MERGE,
      ]);
    });

    it("keeps 'Base branch was modified' when the base really moved (negative)", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: refuse(405, "Base branch was modified. Review and try the merge again."),
        [PULL]: () => pull(true),
        [BASE_REF]: baseAt("b2"),
      });
      await expect(
        gh.mergePullRequest(repo, { ...args, base: "b1" }),
      ).rejects.toMatchObject({
        reason: "github_refused",
        message: expect.stringContaining("Base branch was modified"),
      });
      expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    });

    it("keeps 'Base branch was modified' at once when the merge names no base (negative)", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: refuse(405, "Base branch was modified. Review and try the merge again."),
        [PULL]: () => pull(true),
      });
      await expect(gh.mergePullRequest(repo, args)).rejects.toMatchObject({
        reason: "github_refused",
      });
      expect(calls.map((c) => c.method)).toEqual(["PUT"]);
    });

    it("checks the base on a 'not mergeable' retry too when the merge names one", async () => {
      const { gh, repo, calls } = await restSeam({
        [MERGE]: refuse(405, "Pull Request is not mergeable"),
        [PULL]: () => pull(true),
        [BASE_REF]: baseAt("b2"),
      });
      await expect(
        gh.mergePullRequest(repo, { ...args, base: "b1" }),
      ).rejects.toMatchObject({ reason: "github_refused" });
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        MERGE,
        PULL,
        BASE_REF,
      ]);
    });
  });

  it("lists changed files, splitting a rename and counting a copy as an addition", async () => {
    const file = (
      path: string,
      status: GitHubPrFile["status"],
      previousPath: string | null = null,
    ): GitHubPrFile => ({
      path,
      status,
      previousPath,
      additions: 0,
      deletions: 0,
      changes: 0,
      patch: null,
    });
    const compareCommits = vi.fn(async () => [
      file("new.toml", "renamed", "old.toml"),
      file("added.toml", "added"),
      file("copy.toml", "copied"),
      file("gone.toml", "removed"),
      file("edit.toml", "modified"),
      file("mode.toml", "changed"),
    ]);
    const { gh, repo } = await restSeam({}, fakeClient({ compareCommits }));
    await expect(gh.changedFiles(repo, "b0", "h1")).resolves.toEqual([
      { path: "old.toml", status: "removed" },
      { path: "new.toml", status: "added" },
      { path: "added.toml", status: "added" },
      { path: "copy.toml", status: "added" },
      { path: "gone.toml", status: "removed" },
      { path: "edit.toml", status: "modified" },
      { path: "mode.toml", status: "modified" },
    ]);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: "a-intel",
      repo: "platform",
      base: "b0",
      head: "h1",
    });
    const failing = await restSeam(
      {},
      fakeClient({
        compareCommits: async () => {
          throw new GitHubApiError(404, "No common ancestor");
        },
      }),
    );
    await expect(
      failing.gh.changedFiles(failing.repo, "b0", "h1"),
    ).rejects.toMatchObject({ reason: "github_refused" });

    // GitHub's compare stops at 300 files without saying so. A list that
    // long may be missing paths, so both reads refuse it; 299 still passes.
    let count = 300;
    const long = await restSeam(
      {},
      fakeClient({
        compareCommits: async () =>
          Array.from({ length: count }, (_, i) => file(`r${i}.toml`, "added")),
      }),
    );
    await expect(
      long.gh.changedFiles(long.repo, "b0", "h1"),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "too_many_files",
      message: expect.stringContaining(
        "h1 changes 300 or more files against b0",
      ),
    });
    await expect(
      long.gh.changedPaths(long.repo, "b0", "h1"),
    ).rejects.toMatchObject({ reason: "too_many_files" });
    count = 299;
    await expect(
      long.gh.changedFiles(long.repo, "b0", "h1"),
    ).resolves.toHaveLength(299);
    await expect(
      long.gh.changedPaths(long.repo, "b0", "h1"),
    ).resolves.toHaveLength(299);
  });

  const commitRoutes = (patch: Route = () => ({})): Record<string, Route> => ({
    [`GET ${REPO_PATH}/git/commits/p1`]: () => ({ tree: { sha: "t0" } }),
    [`POST ${REPO_PATH}/git/trees`]: () => ({ sha: "t1" }),
    [`POST ${REPO_PATH}/git/commits`]: () => ({ sha: "c9" }),
    [`PATCH ${REPO_PATH}/git/refs/heads/steering/ctx.rule`]: patch,
  });

  it("writes one commit on the parent's tree and fast-forwards the branch to it", async () => {
    const { gh, repo, calls } = await restSeam(commitRoutes());
    await expect(
      gh.commitFiles(repo, {
        branch: "steering/ctx.rule",
        parent: "p1",
        message: "Stamp",
        files: [
          { path: "steering/rules/r.toml", content: "id = 1" },
          { path: "old.toml", content: null },
        ],
      }),
    ).resolves.toEqual({ sha: "c9" });
    expect(calls.map((c) => c.body)).toEqual([
      undefined,
      {
        base_tree: "t0",
        tree: [
          {
            path: "steering/rules/r.toml",
            mode: "100644",
            type: "blob",
            content: "id = 1",
          },
          { path: "old.toml", mode: "100644", type: "blob", sha: null },
        ],
      },
      { message: "Stamp", tree: "t1", parents: ["p1"] },
      { sha: "c9", force: false },
    ]);
  });

  it("refuses a stamp whose branch moved as head_moved, and any other refusal as github_refused", async () => {
    const args = {
      branch: "steering/ctx.rule",
      parent: "p1",
      message: "Stamp",
      files: [{ path: "a", content: "1" }],
    };
    const moved = await restSeam(
      commitRoutes(refuse(422, "Update is not a fast forward")),
    );
    await expect(moved.gh.commitFiles(moved.repo, args)).rejects.toMatchObject({
      code: "conflict",
      reason: "head_moved",
    });
    const locked = await restSeam(commitRoutes(refuse(403, "Forbidden")));
    await expect(
      locked.gh.commitFiles(locked.repo, args),
    ).rejects.toMatchObject({ reason: "github_refused" });
    const badTree = await restSeam({
      ...commitRoutes(),
      [`POST ${REPO_PATH}/git/trees`]: refuse(422, "tree.path is invalid"),
    });
    await expect(
      badTree.gh.commitFiles(badTree.repo, args),
    ).rejects.toMatchObject({
      reason: "github_refused",
      message: expect.stringContaining("tree.path is invalid"),
    });
  });

  it("says a head holds a commit when the compare is ahead or identical", async () => {
    let status = "ahead";
    const { gh, repo, calls } = await restSeam({
      [`GET ${REPO_PATH}/compare/m1...h1?per_page=1`]: () => ({ status }),
    });
    await expect(gh.holdsCommit(repo, "h1", "h1")).resolves.toBe(true);
    expect(calls).toEqual([]);
    await expect(gh.holdsCommit(repo, "h1", "m1")).resolves.toBe(true);
    status = "identical";
    await expect(gh.holdsCommit(repo, "h1", "m1")).resolves.toBe(true);
    status = "diverged";
    await expect(gh.holdsCommit(repo, "h1", "m1")).resolves.toBe(false);
    status = "behind";
    await expect(gh.holdsCommit(repo, "h1", "m1")).resolves.toBe(false);
    await expect(gh.holdsCommit(repo, "h2", "m1")).rejects.toMatchObject({
      reason: "github_refused",
    });
  });

  it("reads a commit's parents in order, none for a root commit", async () => {
    const { gh, repo } = await restSeam({
      [`GET ${REPO_PATH}/git/commits/s1`]: () => ({
        sha: "s1",
        parents: [{ sha: "m1" }],
      }),
      [`GET ${REPO_PATH}/git/commits/u1`]: () => ({
        sha: "u1",
        parents: [{ sha: "h1" }, { sha: "m1" }],
      }),
      [`GET ${REPO_PATH}/git/commits/r1`]: () => ({ sha: "r1", parents: [] }),
    });
    await expect(gh.commitParents(repo, "s1")).resolves.toEqual(["m1"]);
    await expect(gh.commitParents(repo, "u1")).resolves.toEqual(["h1", "m1"]);
    await expect(gh.commitParents(repo, "r1")).resolves.toEqual([]);
    await expect(gh.commitParents(repo, "x9")).rejects.toMatchObject({
      reason: "github_refused",
    });
  });

  it("merges the main head it was given into the branch and answers the new head and its parents, or the old head when nothing changed", async () => {
    let merged: unknown = { sha: "u1", parents: [{ sha: "h1" }, { sha: "m1" }] };
    const getBranch = vi.fn(async () => ({ name: "b", sha: "h1" }));
    const { gh, repo, calls } = await restSeam(
      { [`POST ${REPO_PATH}/merges`]: () => merged },
      fakeClient({ getBranch }),
    );
    const args = {
      number: 7,
      branch: "steering/ctx.rule",
      expectedHead: "h1",
      base: "m1",
    };
    await expect(gh.updateBranch(repo, args)).resolves.toEqual({
      headSha: "u1",
      parents: ["h1", "m1"],
    });
    expect(calls[0]!.body).toEqual({ base: "steering/ctx.rule", head: "m1" });
    merged = undefined;
    await expect(gh.updateBranch(repo, args)).resolves.toEqual({
      headSha: "h1",
      parents: null,
    });
  });

  it("refuses an update that merged main into a push made after the head was read", async () => {
    let merged: unknown = { sha: "u2", parents: [{ sha: "h2" }, { sha: "m1" }] };
    const getBranch = vi.fn(async () => ({ name: "b", sha: "h1" }));
    const { gh, repo } = await restSeam(
      { [`POST ${REPO_PATH}/merges`]: () => merged },
      fakeClient({ getBranch }),
    );
    const args = {
      number: 7,
      branch: "steering/ctx.rule",
      expectedHead: "h1",
      base: "m1",
    };
    await expect(gh.updateBranch(repo, args)).rejects.toMatchObject({
      code: "conflict",
      reason: "head_moved",
    });
    merged = { sha: "u2" };
    await expect(gh.updateBranch(repo, args)).rejects.toMatchObject({
      reason: "head_moved",
    });
  });

  it("refuses a branch update on a moved head, a conflict, or any other refusal", async () => {
    const getBranch = vi.fn(async () => ({ name: "b", sha: "h2" }));
    const args = {
      number: 7,
      branch: "steering/ctx.rule",
      expectedHead: "h1",
      base: "m1",
    };
    const moved = await restSeam({}, fakeClient({ getBranch }));
    await expect(moved.gh.updateBranch(moved.repo, args)).rejects.toMatchObject(
      { reason: "head_moved" },
    );
    expect(moved.calls).toEqual([]);
    const at = fakeClient({ getBranch: async () => ({ name: "b", sha: "h1" }) });
    const conflicted = await restSeam(
      { [`POST ${REPO_PATH}/merges`]: refuse(409, "Merge conflict") },
      at,
    );
    await expect(
      conflicted.gh.updateBranch(conflicted.repo, args),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "update_conflict",
      message: expect.stringContaining("main does not merge cleanly"),
    });
    const refused = await restSeam(
      { [`POST ${REPO_PATH}/merges`]: refuse(403, "Forbidden") },
      at,
    );
    await expect(
      refused.gh.updateBranch(refused.repo, args),
    ).rejects.toMatchObject({ reason: "github_refused" });
  });

  describe("resetBranch", () => {
    const branch = "steering/ctx.rule";
    const args = { from: "s1", to: "p1" };
    const repoInfo = { [`GET ${REPO_PATH}`]: () => ({ node_id: "R_1" }) };
    const at = (sha: string | null) =>
      fakeClient({
        getBranch: vi.fn(async () => (sha ? { name: "b", sha } : null)),
      });

    it("moves the ref back only while it still points at the stamp", async () => {
      const getBranch = vi.fn();
      const { gh, repo, calls } = await restSeam(
        {
          ...repoInfo,
          "POST /graphql": () => ({
            data: { updateRefs: { clientMutationId: null } },
          }),
        },
        fakeClient({ getBranch }),
      );
      await expect(gh.resetBranch(repo, branch, args)).resolves.toBe(true);
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        `GET ${REPO_PATH}`,
        "POST /graphql",
      ]);
      expect(calls[1]!.body).toMatchObject({
        query: expect.stringContaining("updateRefs"),
        variables: {
          repositoryId: "R_1",
          refUpdates: [
            {
              name: "refs/heads/steering/ctx.rule",
              afterOid: "p1",
              beforeOid: "s1",
              force: true,
            },
          ],
        },
      });
      expect(getBranch).not.toHaveBeenCalled();
    });

    it("leaves a branch that moved off the stamp", async () => {
      const graphql = () => ({
        data: { updateRefs: null },
        errors: [{ message: "Ref was not at the expected value" }],
      });
      for (const sha of ["h9", null]) {
        const { gh, repo } = await restSeam(
          { ...repoInfo, "POST /graphql": graphql },
          at(sha),
        );
        await expect(gh.resetBranch(repo, branch, args)).resolves.toBe(false);
      }
    });

    it("answers true when the reset landed but its answer was lost", async () => {
      const { gh, repo } = await restSeam(
        { ...repoInfo, "POST /graphql": refuse(502, "Bad Gateway") },
        at("p1"),
      );
      await expect(gh.resetBranch(repo, branch, args)).resolves.toBe(true);
    });

    it("wraps a refusal when the branch is still at the stamp", async () => {
      const errors = await restSeam(
        {
          ...repoInfo,
          "POST /graphql": () => ({
            data: { updateRefs: null },
            errors: [{ message: "Resource not accessible" }, { message: "x" }],
          }),
        },
        at("s1"),
      );
      await expect(
        errors.gh.resetBranch(errors.repo, branch, args),
      ).rejects.toMatchObject({
        reason: "github_refused",
        message: "Resource not accessible; x",
      });
      const http = await restSeam(
        { [`GET ${REPO_PATH}`]: refuse(403, "Forbidden") },
        at("s1"),
      );
      await expect(
        http.gh.resetBranch(http.repo, branch, args),
      ).rejects.toMatchObject({
        reason: "github_refused",
        message: expect.stringContaining("Forbidden"),
      });
      const unread = await restSeam(
        { [`GET ${REPO_PATH}`]: refuse(403, "Forbidden") },
        fakeClient({
          getBranch: vi.fn().mockRejectedValue(new Error("unreachable")),
        }),
      );
      await expect(
        unread.gh.resetBranch(unread.repo, branch, args),
      ).rejects.toMatchObject({
        reason: "github_refused",
        message: expect.stringContaining("Forbidden"),
      });
    });
  });

  it("lists each reviewer's standing approval across pages, with the linked Oxagen user", async () => {
    const review = (id: number, state: string, commit = "h1") => ({
      user: { id, login: `u${id}` },
      state,
      commit_id: commit,
    });
    const first = [
      review(11, "APPROVED", "h0"),
      ...Array.from({ length: 99 }, () => review(12, "COMMENTED")),
    ];
    const second = [
      review(11, "APPROVED"),
      review(13, "APPROVED"),
      review(13, "CHANGES_REQUESTED"),
      { user: null, state: "APPROVED", commit_id: "h1" },
    ];
    const { gh, repo, calls, linkAccount } = await restSeam({
      [`GET ${REPO_PATH}/pulls/7/reviews?per_page=100&page=1`]: () => first,
      [`GET ${REPO_PATH}/pulls/7/reviews?per_page=100&page=2`]: () => second,
    });
    await expect(gh.listApprovals(repo, 7)).resolves.toEqual([
      { userId: "user-11", login: "u11", commitSha: "h1" },
    ]);
    expect(calls).toHaveLength(2);
    expect(linkAccount).toHaveBeenCalledWith("github", "11");
    const refused = await restSeam({});
    await expect(refused.gh.listApprovals(refused.repo, 7)).rejects.toMatchObject(
      { reason: "github_refused" },
    );
  });

  it("keeps a dismissed approval from standing", () => {
    expect(
      standingApprovals([
        { user: { id: 1, login: "a" }, state: "APPROVED", commit_id: "h" },
        { user: { id: 1, login: "a" }, state: "DISMISSED", commit_id: "h" },
        { user: { id: 2, login: "b" }, state: "PENDING", commit_id: null },
      ]),
    ).toEqual([]);
  });

  it("records a publish as a deployment to the steering environment", async () => {
    const { gh, repo, calls } = await restSeam({
      [`POST ${REPO_PATH}/deployments`]: () => ({ id: 41 }),
      [`POST ${REPO_PATH}/deployments/41/statuses`]: () => ({ id: 1 }),
    });
    await expect(
      gh.recordDeployment(repo, {
        sha: "sq1",
        ref: "main",
        environment: "steering",
        description: "Steering version 3",
      }),
    ).resolves.toEqual({
      url: "https://github.com/a-intel/platform/deployments/steering",
    });
    expect(calls[0]!.body).toMatchObject({
      ref: "sq1",
      environment: "steering",
      required_contexts: [],
    });
    const refused = await restSeam({
      [`POST ${REPO_PATH}/deployments`]: refuse(403, "Resource not accessible"),
    });
    await expect(
      refused.gh.recordDeployment(refused.repo, {
        sha: "sq1",
        ref: "main",
        environment: "steering",
        description: "d",
      }),
    ).rejects.toMatchObject({ reason: "github_refused" });
  });

  it("lists a commit's files with their blob ids, leaving out directories and submodules", async () => {
    const { gh, repo, calls } = await restSeam({
      [`GET ${REPO_PATH}/git/commits/c1`]: () => ({ tree: { sha: "t1" } }),
      [`GET ${REPO_PATH}/git/trees/t1?recursive=1`]: () => ({
        truncated: false,
        tree: [
          { path: "rules", type: "tree", sha: "t2" },
          { path: "rules/a.toml", type: "blob", sha: "b1" },
          { path: "vendor", type: "commit", sha: "s1" },
        ],
      }),
    });
    await expect(gh.listTree(repo, "c1")).resolves.toEqual([
      { path: "rules/a.toml", blob: "b1" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("walks a tree GitHub cut short one directory at a time", async () => {
    const { gh, repo } = await restSeam({
      [`GET ${REPO_PATH}/git/commits/c1`]: () => ({ tree: { sha: "t1" } }),
      [`GET ${REPO_PATH}/git/trees/t1?recursive=1`]: () => ({
        truncated: true,
        tree: [],
      }),
      [`GET ${REPO_PATH}/git/trees/t1`]: () => ({
        tree: [
          { path: "rules", type: "tree", sha: "t2" },
          { path: "README.md", type: "blob", sha: "b0" },
        ],
      }),
      [`GET ${REPO_PATH}/git/trees/t2`]: () => ({
        tree: [{ path: "a.toml", type: "blob", sha: "b1" }],
      }),
    });
    const entries = await gh.listTree(repo, "c1");
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        { path: "README.md", blob: "b0" },
        { path: "rules/a.toml", blob: "b1" },
      ]),
    );
  });

  it("refuses a tree when even one directory's listing is cut short", async () => {
    const { gh, repo } = await restSeam({
      [`GET ${REPO_PATH}/git/commits/c1`]: () => ({ tree: { sha: "t1" } }),
      [`GET ${REPO_PATH}/git/trees/t1?recursive=1`]: () => ({
        truncated: true,
        tree: [],
      }),
      [`GET ${REPO_PATH}/git/trees/t1`]: () => ({ truncated: true, tree: [] }),
    });
    await expect(gh.listTree(repo, "c1")).rejects.toMatchObject({
      reason: "tree_too_large",
    });
    const missing = await restSeam({});
    await expect(
      missing.gh.listTree(missing.repo, "c1"),
    ).rejects.toMatchObject({ reason: "github_refused" });
  });

  it("tags a commit, and keeps a tag that already names that commit", async () => {
    const { gh, repo, calls } = await restSeam({
      [`POST ${REPO_PATH}/git/refs`]: () => ({ ref: "refs/tags/steering/3" }),
    });
    await expect(
      gh.createTag(repo, "steering/3", "sq1"),
    ).resolves.toBeUndefined();
    expect(calls[0]!.body).toEqual({ ref: "refs/tags/steering/3", sha: "sq1" });
    const again = await restSeam({
      [`POST ${REPO_PATH}/git/refs`]: refuse(422, "Reference already exists"),
      [`GET ${REPO_PATH}/git/ref/tags/steering/3`]: () => ({
        object: { sha: "sq1" },
      }),
    });
    await expect(
      again.gh.createTag(again.repo, "steering/3", "sq1"),
    ).resolves.toBeUndefined();
  });

  it("refuses to move a tag that names another commit", async () => {
    const { gh, repo } = await restSeam({
      [`POST ${REPO_PATH}/git/refs`]: refuse(422, "Reference already exists"),
      [`GET ${REPO_PATH}/git/ref/tags/steering/3`]: () => ({
        object: { sha: "sq0" },
      }),
    });
    await expect(gh.createTag(repo, "steering/3", "sq1")).rejects.toMatchObject(
      { reason: "tag_exists", message: expect.stringContaining("sq0") },
    );
    const refused = await restSeam({
      [`POST ${REPO_PATH}/git/refs`]: refuse(403, "Resource not accessible"),
    });
    await expect(
      refused.gh.createTag(refused.repo, "steering/3", "sq1"),
    ).rejects.toMatchObject({ reason: "github_refused" });
    const unreadable = await restSeam({
      [`POST ${REPO_PATH}/git/refs`]: refuse(422, "Reference already exists"),
    });
    await expect(
      unreadable.gh.createTag(unreadable.repo, "steering/3", "sq1"),
    ).rejects.toMatchObject({ reason: "github_refused" });
  });

  it("refuses a REST call on a handle it did not resolve", async () => {
    const { gh, repo } = await restSeam({});
    const forged = { ...repo };
    await expect(gh.holdsCommit(forged, "h1", "m1")).rejects.toThrow(
      "no client",
    );
  });
});
