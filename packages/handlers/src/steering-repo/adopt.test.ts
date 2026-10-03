// adopt.test.ts: adopt_steering_merges (#5195) against a scripted GitHub and
// fake deps. GitHub answers through the real REST client. Each refusal is
// checked to write nothing to the host, read no health, publish nothing, and
// emit nothing, so Repair settings still offers the revert.
import { createGithubRest } from "@oxagen/github/provision";
import type { SecurityEventInput } from "@oxagen/telemetry";
import { describe, expect, it, vi } from "vitest";
import { fail, GITHUB_BASE, ok, type Reply, server } from "./__tests__/scripted-http";
import { type AdoptDeps, adoptHostMerges } from "./adopt";
import type { GithubHistoryTarget } from "./diverged";
import type { HealthOutcome, HealthRow } from "./health";
import type { LocatedTarget } from "./health.hosts";

vi.mock("../logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger")>()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };
const ADOPTER = "user-adopter";
const AUTHOR = "user-author";
const ROOT = "/repos/acme/steering";
/** The published commit, version 7. */
const P = "a1".repeat(20);
/** The import PR's merge commit, made on GitHub by a person. */
const M = "b2".repeat(20);
/** The head Oxagen opened the import PR with. */
const H = "c3".repeat(20);
const OTHER = "d4".repeat(20);
const IMPORT_TITLE = "Import steering from .oxagen/ (#2)";

const LOCATED: LocatedTarget = {
  target: {
    scope: SCOPE,
    provider: "github",
    repository: { id: 812, full_name: "acme/steering" },
    deepLink: "/acme/main/repositories",
  },
  connection: null,
  owner: "acme",
  name: "steering",
};

const ROW: HealthRow = {
  provider: "github",
  repositoryId: 812,
  repository: "acme/steering",
  health: "diverged",
  differences: [],
  reason: "main holds 1 commit Oxagen did not merge: b2b2b2b",
  publishedSha: P,
  publishedVersion: 7,
  revertPrNumber: 4,
  notifiedHealth: "diverged",
  postedDigest: null,
  checkedAt: new Date("2026-10-03T08:00:00Z"),
  changedAt: new Date("2026-10-03T08:00:00Z"),
};

const HEALTHY: HealthOutcome = {
  health: "healthy",
  previous: "diverged",
  differences: [],
  reason: null,
  posted: 0,
  restored: 0,
  notified: true,
};

const FILES = [
  { filename: "steering/records/rule-a.md", status: "added", sha: "aa".repeat(20) },
  { filename: "workspace.toml", status: "modified", sha: "bb".repeat(20) },
];

const ADOPTION_RUNS = `GET ${ROOT}/commits/${M}/check-runs?check_name=Oxagen%20steering%20adoption&app_id=1234`;
const CHECK_RUNS = `POST ${ROOT}/check-runs`;

/** GitHub as it stands after a person merged Oxagen's import PR #2 on the host. */
function hostMerged(): Record<string, Reply> {
  return {
    [`GET ${ROOT}/deployments?environment=steering&per_page=30`]: ok([
      {
        sha: P,
        payload: { version: 7 },
        performed_via_github_app: { id: 1234, slug: "oxagen-steering" },
      },
    ]),
    [`GET ${ROOT}/compare/${P}...main?per_page=100`]: ok({
      status: "ahead",
      total_commits: 1,
      base_commit: { commit: { tree: { sha: "f6".repeat(20) } } },
      commits: [
        {
          sha: M,
          parents: [{ sha: P }],
          commit: { message: IMPORT_TITLE, tree: { sha: "07".repeat(20) } },
        },
      ],
    }),
    [`GET ${ROOT}/commits/${M}/pulls?per_page=100`]: ok([{ number: 2 }]),
    [`GET ${ROOT}/pulls/2`]: ok({
      number: 2,
      merged: true,
      merge_commit_sha: M,
      base: { ref: "main", repo: { id: 812, full_name: "acme/steering" } },
      head: { sha: H },
      merged_by: { type: "User", login: "mac" },
    }),
    [ADOPTION_RUNS]: ok({ total_count: 0, check_runs: [] }),
    [`GET ${ROOT}/commits/${M}`]: ok({ sha: M, files: FILES }),
    [`GET ${ROOT}/pulls/2/files?per_page=100`]: ok(FILES),
    [CHECK_RUNS]: ok({ id: 77 }, 201),
  };
}

function rig(routes: Record<string, Reply> = hostMerged(), over: Partial<AdoptDeps> = {}) {
  const s = server(GITHUB_BASE, routes);
  const target: GithubHistoryTarget = {
    rest: createGithubRest({ token: "ghs_test", fetch: s.fetch }),
    repo: { owner: "acme", name: "steering", id: 812 },
    app: { symbol: "oxagen-steering", id: 1234, slug: "oxagen-steering" },
  };
  const events: SecurityEventInput[] = [];
  const refresh = vi.fn(async (): Promise<HealthOutcome | null> => HEALTHY);
  const publish = vi.fn(async (): Promise<number | null> => 8);
  const findPull = vi.fn(async (_scope: unknown, _repository: string, number: number) =>
    number === 2 ? { publicId: "prp_import", headSha: H, createdById: AUTHOR } : null,
  );
  const deps: AdoptDeps = {
    now: () => new Date("2026-10-03T09:00:00.000Z"),
    locate: async () => LOCATED,
    loadRow: async () => ROW,
    history: async () => target,
    findPull,
    mode: async () => "team",
    roles: async () => ({ orgRole: "Admin", workspaceRole: null }),
    refresh,
    publish,
    emit: (event) => {
      events.push(event);
    },
    ...over,
  };
  const adopt = () =>
    adoptHostMerges(SCOPE, { actorUserId: ADOPTER, requestId: "req-1" }, deps);
  return { s, deps, events, refresh, publish, findPull, adopt };
}

/** Nothing reached the host, the health, the publisher, or the audit log. */
function expectNothingWritten(r: ReturnType<typeof rig>) {
  expect(r.s.writes()).toEqual([]);
  expect(r.refresh).not.toHaveBeenCalled();
  expect(r.publish).not.toHaveBeenCalled();
  expect(r.events).toEqual([]);
}

describe("adoptHostMerges", () => {
  it("adopts a host merge of a pull request Oxagen opened, records it, and publishes main", async () => {
    const r = rig();

    await expect(r.adopt()).resolves.toEqual({
      health: "healthy",
      adopted: [{ commit: M, pullRequest: 2 }],
      publishedVersion: 8,
    });

    // The adoption check run on the merge commit is the record later reads count.
    expect(r.s.writes()).toEqual([
      {
        method: "POST",
        path: `${ROOT}/check-runs`,
        body: {
          name: "Oxagen steering adoption",
          head_sha: M,
          status: "completed",
          conclusion: "success",
          external_id: "oxagen-steering-adoption",
          output: {
            title: "Adopted in Oxagen",
            summary: `Adopted in Oxagen by user ${ADOPTER} at 2026-10-03T09:00:00.000Z, as the merge of pull request #2.`,
          },
        },
      },
    ]);
    expect(r.findPull).toHaveBeenCalledWith(SCOPE, "acme/steering", 2);
    expect(r.refresh).toHaveBeenCalledWith(SCOPE, expect.objectContaining({ reason: "adoption" }));
    expect(r.publish).toHaveBeenCalledWith(SCOPE);
    expect(r.events).toEqual([
      {
        eventType: "steering.published",
        actorUserId: ADOPTER,
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        capability: "adopt_steering_merges",
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId: "req-1",
        detail: {
          fullName: "acme/steering",
          adopted: [{ commit: M, pullRequest: 2 }],
          publishedVersion: 8,
        },
      },
    ]);
  });

  it("keeps the adoption and its record when the publish fails, and answers no version", async () => {
    const r = rig(hostMerged(), {
      publish: async () => {
        throw new Error("bundle store unreachable");
      },
    });

    await expect(r.adopt()).resolves.toMatchObject({ health: "healthy", publishedVersion: null });
    expect(r.s.writes()).toHaveLength(1);
    expect(r.events[0]?.detail).toEqual({
      fullName: "acme/steering",
      adopted: [{ commit: M, pullRequest: 2 }],
      publishedVersion: null,
    });
  });

  it("publishes nothing when the read after the adoption is still not healthy", async () => {
    const r = rig(hostMerged(), { refresh: async () => ({ ...HEALTHY, health: "drifted" }) });

    await expect(r.adopt()).resolves.toMatchObject({ health: "drifted", publishedVersion: null });
    expect(r.publish).not.toHaveBeenCalled();
  });

  describe("refusals write nothing, so Repair still offers the revert", () => {
    it("refuses a merge of a pull request Oxagen did not open", async () => {
      const r = rig(hostMerged(), { findPull: vi.fn(async () => null) });

      await expect(r.adopt()).rejects.toMatchObject({
        code: "conflict",
        reason: "adoption_refused",
        message: expect.stringContaining("Pull request #2 was not opened by Oxagen"),
      });
      expectNothingWritten(r);
    });

    it("refuses a commit that landed without a pull request", async () => {
      const routes = hostMerged();
      routes[`GET ${ROOT}/commits/${M}/pulls?per_page=100`] = ok([]);
      routes[`GET ${ROOT}/compare/${P}...main?per_page=100`] = ok({
        status: "ahead",
        total_commits: 1,
        base_commit: { commit: { tree: { sha: "f6".repeat(20) } } },
        commits: [
          {
            sha: M,
            parents: [{ sha: P }],
            commit: { message: "Edit a rule by hand", tree: { sha: "07".repeat(20) } },
          },
        ],
      });
      const r = rig(routes);

      await expect(r.adopt()).rejects.toMatchObject({
        reason: "adoption_refused",
        message: expect.stringContaining("did not land through a pull request"),
      });
      expectNothingWritten(r);
    });

    it("refuses a pull request merged at another head than the one Oxagen opened", async () => {
      const r = rig(hostMerged(), {
        findPull: vi.fn(async () => ({ publicId: "prp_import", headSha: OTHER, createdById: AUTHOR })),
      });

      await expect(r.adopt()).rejects.toMatchObject({
        reason: "adoption_refused",
        message: expect.stringContaining("not at the head Oxagen opened it with"),
      });
      expectNothingWritten(r);
    });

    it("refuses a merge commit that changes other files than its pull request", async () => {
      const routes = hostMerged();
      routes[`GET ${ROOT}/commits/${M}`] = ok({
        sha: M,
        files: [...FILES, { filename: "steering/records/extra.md", status: "added", sha: "ee".repeat(20) }],
      });
      const r = rig(routes);

      await expect(r.adopt()).rejects.toMatchObject({
        reason: "adoption_refused",
        message: expect.stringContaining("changes other files than pull request #2"),
      });
      expectNothingWritten(r);
    });

    it("refuses a main that no longer contains the published commit", async () => {
      const routes = hostMerged();
      routes[`GET ${ROOT}/compare/${P}...main?per_page=100`] = fail(404, "Not Found");
      const r = rig(routes);

      await expect(r.adopt()).rejects.toMatchObject({ reason: "adoption_refused" });
      expectNothingWritten(r);
    });

    it("refuses a person the governance mode does not let merge", async () => {
      for (const over of [
        // Team mode needs an org Owner or Admin, or a workspace Owner.
        { roles: async () => ({ orgRole: null, workspaceRole: "Member" }) },
        // The person who opened the pull request cannot adopt it in team mode.
        { roles: async () => ({ orgRole: "Admin", workspaceRole: null }), findPull: vi.fn(async () => ({ publicId: "prp_import", headSha: H, createdById: ADOPTER })) },
      ]) {
        const r = rig(hostMerged(), over);
        await expect(r.adopt()).rejects.toMatchObject({ code: "forbidden" });
        expectNothingWritten(r);
      }
    });

    it("refuses a repo that is not diverged, a GitLab repo, and a call with no person", async () => {
      const healthy = rig(hostMerged(), { loadRow: async () => ({ ...ROW, health: "healthy" }) });
      await expect(healthy.adopt()).rejects.toMatchObject({ reason: "nothing_to_adopt" });
      expectNothingWritten(healthy);

      const gitlab = rig(hostMerged(), {
        locate: async () => ({ ...LOCATED, target: { ...LOCATED.target, provider: "gitlab" } }),
      });
      await expect(gitlab.adopt()).rejects.toMatchObject({ reason: "adoption_unsupported" });
      expectNothingWritten(gitlab);

      const nobody = rig();
      await expect(
        adoptHostMerges(SCOPE, { actorUserId: null, requestId: null }, nobody.deps),
      ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
      expectNothingWritten(nobody);
    });
  });

  it("adopts nothing more on a second call, and publishes main", async () => {
    const routes = hostMerged();
    routes[ADOPTION_RUNS] = ok({
      total_count: 1,
      check_runs: [
        {
          id: 9,
          name: "Oxagen steering adoption",
          status: "completed",
          conclusion: "success",
          external_id: "oxagen-steering-adoption",
          app: { id: 1234 },
        },
      ],
    });
    const r = rig(routes);

    await expect(r.adopt()).resolves.toEqual({
      health: "healthy",
      adopted: [],
      publishedVersion: 8,
    });
    expect(r.s.writes()).toEqual([]);
  });
});
