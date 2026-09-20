import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { schema } from "@oxagen/database";
import type { GitHubClient } from "@oxagen/github";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

import {
  assertProductionBase,
  createSteeringGitHub,
  readGitHubConnection,
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
   * after the bind changes `getRepoInfo().defaultBranch` and nothing else: the
   * binding is immutable and the settings page still names the approved ref.
   * If steering followed GitHub, every Context PR would be opened against,
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
   * `open_context_pr` dots `fullName` into the `set_id` at the top of every
   * Context record file and stores it as the proposal row's `repository`, so
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

  it("refuses a Context PR retargeted at the branch GitHub now calls default", async () => {
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
    ).toThrow(/targets main; a Context PR merges only into release/);
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
 * `bind_main_repository` writes a binding head and a binding version; the
 * settings-path connection it binds through carries only the installation id
 * the install callback attached, never an owner/repo. A read that looked only
 * at `delivery_config` answered null right after a successful bind, and every
 * Context PR behaved as though no repository were connected.
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

  it("resolves the repository and the approved ref the bind recorded, on a connection that names none", async () => {
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
  // repository the workspace can see and is not steered by. Context PRs and
  // `get_steering_freshness` both resolve through this read, so an unordered
  // `limit(1)` without the filter could steer either one by a linked head.
  it("names the head's role in the joined read, so only a main head steers", async () => {
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
   * repository still bound. `bind_main_repository` on the SAME repository is
   * what moves the head onto the live connection and brings the join back.
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
   * first hands steering and every Context PR to whatever repository a
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
  it("asks only for the main head, on both reads", async () => {
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
      expect(query.sql).toMatch(/"role" = \$\d+/);
      expect(query.params).toContain("main");
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
});
