// repair.test.ts: repair() over fake dependencies, and the GitHub and GitLab
// repair hosts. Settings writes go through the fake GitHub and GitLab the
// provisioning tests use. Merge calls go through a scripted server. Both run
// the real REST clients.
import { GitHubApiError, GitHubRateLimitedError } from "@oxagen/github";
import * as gh from "@oxagen/github/provision";
import * as gl from "@oxagen/gitlab/provision";
import { HandlerError } from "@oxagen/oxagen";
import { GITHUB_SETTINGS_BASELINE, GITLAB_SETTINGS_BASELINE } from "@oxagen/oxagen/steering-repo";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STEERING_APP_UNCONFIGURED_MESSAGE } from "../lib/steering-app";
import {
  type SteeringConnection,
  steeringGroupToken,
  steeringInstallationRest,
} from "../steering_repo.provision";
import { APP, BOT, baselineProject, baselineRepo, REPO, withRepositories } from "./__tests__/fakes";
import { fail, GITHUB_BASE, GITLAB_BASE, ok, server } from "./__tests__/scripted-http";
import { REVERT_TRAILER, revertMessage, revertTitle } from "./diverged";
import {
  type HealthOutcome,
  type HealthRow,
  type PublishedCommit,
  productionHealthStorage,
  refreshRepoHealth,
} from "./health";
import { loadHealthTarget, type LocatedTarget } from "./health.hosts";
import {
  githubRepairHost,
  gitlabRepairHost,
  productionRepairDeps,
  type RepairDeps,
  type RepairHost,
  repair,
  repairHostFor,
} from "./repair";

const mocks = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));

vi.mock("../logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger")>()),
  logger: { info: mocks.info, warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../steering_repo.provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../steering_repo.provision")>()),
  steeringInstallationRest: vi.fn(),
  steeringGroupToken: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };
const INPUT = { actorUserId: "user-1" };
const NOW = new Date("2026-09-27T12:00:00.000Z");
const PUBLISHED: PublishedCommit = { sha: "a1".repeat(20), version: 7 };
const REVERT_REF = "steering/revert-to-a1a1a1a-d4d4d4d";
const HEAD = "d4".repeat(20);

function located(
  provider: "github" | "gitlab",
  connection: SteeringConnection | null,
): LocatedTarget {
  return {
    target: {
      scope: SCOPE,
      provider,
      repository: { id: 1, full_name: "acme/steering" },
      deepLink: "/acme/main/repositories",
    },
    connection,
    owner: "acme",
    name: "steering",
  };
}

function row(health: RepoHealth, over: Partial<HealthRow> = {}): HealthRow {
  return {
    provider: "github",
    repositoryId: 1,
    repository: "acme/steering",
    health,
    differences: [],
    reason: null,
    publishedSha: PUBLISHED.sha,
    publishedVersion: PUBLISHED.version,
    revertPrNumber: null,
    notifiedHealth: health,
    postedDigest: null,
    checkedAt: NOW,
    changedAt: NOW,
    ...over,
  };
}

function outcome(health: RepoHealth, reason: string | null = null): HealthOutcome {
  return {
    health,
    previous: null,
    differences: [],
    reason,
    posted: 0,
    restored: 0,
    notified: false,
  };
}

function fakeHost(over: Partial<RepairHost> = {}) {
  return {
    name: vi.fn(() => "acme/steering"),
    applyBaseline: vi.fn(async () => [] as string[]),
    mergeRevert: vi.fn(async () => ({ kind: "merged" }) as const),
    ...over,
  } satisfies RepairHost;
}

function fakeDeps(opts: {
  host?: RepairHost | null;
  rows?: (HealthRow | null)[];
  outcomes?: (HealthOutcome | null)[];
  located?: LocatedTarget | null;
}) {
  const rows = [...(opts.rows ?? [row("healthy")])];
  const outcomes = [...(opts.outcomes ?? [outcome("healthy")])];
  const next = <T>(list: T[]): T => (list.length > 1 ? (list.shift() as T) : (list[0] as T));
  const deps = {
    now: () => NOW,
    locate: vi.fn(async () =>
      opts.located === undefined ? located("github", GITHUB_CONNECTION) : opts.located,
    ),
    loadRow: vi.fn(async () => next(rows)),
    host: vi.fn(async () => (opts.host === undefined ? fakeHost() : opts.host)),
    refresh: vi.fn(async () => next(outcomes)),
  } satisfies RepairDeps;
  return deps;
}

const REPAIR_TRIGGER = {
  reason: "repair",
  actor: null,
  at: NOW.toISOString(),
  settings: [],
  pull_request: null,
};

describe("repair", () => {
  it("refuses a scope with no ready steering repo", async () => {
    const deps = fakeDeps({ located: null });

    await expect(repair(SCOPE, INPUT, deps)).rejects.toMatchObject({
      code: "not_found",
      reason: "steering_repo_not_ready",
    });
    expect(deps.host).not.toHaveBeenCalled();
  });

  it("refuses when the deployment has no Oxagen Steering app", async () => {
    const deps = fakeDeps({ host: null });

    const err = await repair(SCOPE, INPUT, deps).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject({
      code: "conflict",
      reason: "steering_app_unconfigured",
      message: STEERING_APP_UNCONFIGURED_MESSAGE,
    });
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("writes the baseline, then reads the health again with a repair trigger", async () => {
    const host = fakeHost();
    const deps = fakeDeps({ host, rows: [row("drifted")], outcomes: [outcome("healthy")] });

    expect(await repair(SCOPE, INPUT, deps)).toEqual({ health: "healthy" });
    expect(host.applyBaseline).toHaveBeenCalledOnce();
    expect(host.mergeRevert).not.toHaveBeenCalled();
    expect(deps.refresh).toHaveBeenCalledOnce();
    expect(deps.refresh).toHaveBeenCalledWith(SCOPE, REPAIR_TRIGGER);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ ...SCOPE, actorUserId: "user-1", health: "healthy" }),
      "steering-repo.repair: repaired the steering repo",
    );
  });

  it("logs the settings the write left different and returns what the read found", async () => {
    const host = fakeHost({ applyBaseline: vi.fn(async () => ["rulesets.oxagen_merges"]) });
    const deps = fakeDeps({ host, outcomes: [outcome("drifted")] });

    expect(await repair(SCOPE, INPUT, deps)).toEqual({ health: "drifted" });
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ remaining: ["rulesets.oxagen_merges"] }),
      "steering-repo.repair: settings still differ after the repair wrote them",
    );
  });

  it("refuses when the last read found the repo disconnected and a new read agrees", async () => {
    const host = fakeHost();
    const deps = fakeDeps({
      host,
      rows: [row("disconnected")],
      outcomes: [outcome("disconnected", "The repository acme/steering was deleted.")],
    });

    await expect(repair(SCOPE, INPUT, deps)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_repo_disconnected",
      message: "The repository acme/steering was deleted.",
    });
    expect(host.applyBaseline).not.toHaveBeenCalled();
  });

  it("names the repo when a disconnected read gives no reason", async () => {
    const deps = fakeDeps({ rows: [row("disconnected")], outcomes: [outcome("disconnected")] });

    await expect(repair(SCOPE, INPUT, deps)).rejects.toMatchObject({
      reason: "steering_repo_disconnected",
      message:
        "Oxagen can no longer reach the steering repo acme/steering. An organization admin must connect it again.",
    });
  });

  it("refuses when a new read of a disconnected repo finds no steering repo", async () => {
    const deps = fakeDeps({ rows: [row("disconnected")], outcomes: [null] });

    await expect(repair(SCOPE, INPUT, deps)).rejects.toMatchObject({
      code: "not_found",
      reason: "steering_repo_not_ready",
    });
  });

  it("repairs a repo a stale row showed as disconnected once a new read reaches it", async () => {
    const host = fakeHost();
    const deps = fakeDeps({
      host,
      rows: [row("disconnected"), row("drifted")],
      outcomes: [outcome("drifted"), outcome("healthy")],
    });

    expect(await repair(SCOPE, INPUT, deps)).toEqual({ health: "healthy" });
    expect(deps.loadRow).toHaveBeenCalledTimes(2);
    expect(deps.refresh).toHaveBeenCalledTimes(2);
    expect(host.applyBaseline).toHaveBeenCalledOnce();
  });

  it.each([
    ["GitHub 403", new GitHubApiError(403, "Resource not accessible by integration")],
    ["GitHub 404", new GitHubApiError(404, "Not Found")],
    ["GitLab 401", new gl.SteeringGitlabReauthorizeError("401 Unauthorized")],
    ["GitLab 403", new gl.GitLabApiError(403, "403 Forbidden")],
    ["a refused token mint", new Error("Oxagen Steering token mint failed (404): Not Found")],
  ])("reads the repo again and refuses on %s", async (_, error) => {
    const host = fakeHost({ applyBaseline: vi.fn(() => Promise.reject(error)) });
    const deps = fakeDeps({
      host,
      outcomes: [outcome("disconnected", "GitHub refused to show the settings.")],
    });

    await expect(repair(SCOPE, INPUT, deps)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_repo_disconnected",
      message: "GitHub refused to show the settings.",
    });
    expect(deps.refresh).toHaveBeenCalledOnce();
    expect(deps.refresh).toHaveBeenCalledWith(SCOPE, REPAIR_TRIGGER);
  });

  it("names the repo when a refused write is followed by no read", async () => {
    const host = fakeHost({
      applyBaseline: vi.fn(() => Promise.reject(new GitHubApiError(403, "Forbidden"))),
    });
    const deps = fakeDeps({ host, outcomes: [null] });

    await expect(repair(SCOPE, INPUT, deps)).rejects.toMatchObject({
      message:
        "Oxagen can no longer reach the steering repo acme/steering. An organization admin must connect it again.",
    });
  });

  it.each([
    ["a GitHub rate limit", new GitHubRateLimitedError(429, "slow down", 60_000)],
    ["a GitLab rate limit", new gl.GitLabRateLimitedError(429, "slow down", 60_000)],
    ["a GitHub outage", new GitHubApiError(502, "Bad Gateway")],
    ["an unexpected error", new Error("socket hang up")],
  ])("throws %s without reading the health", async (_, error) => {
    const host = fakeHost({ applyBaseline: vi.fn(() => Promise.reject(error)) });
    const deps = fakeDeps({ host });

    await expect(repair(SCOPE, INPUT, deps)).rejects.toBe(error);
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("merges the revert pull request of a diverged repo before reading the health", async () => {
    const host = fakeHost();
    const deps = fakeDeps({ host, rows: [row("diverged", { revertPrNumber: 12 })] });

    expect(await repair(SCOPE, INPUT, deps)).toEqual({ health: "healthy" });
    expect(host.mergeRevert).toHaveBeenCalledOnce();
    expect(host.mergeRevert).toHaveBeenCalledWith(12, PUBLISHED);
    expect(mocks.info).toHaveBeenCalledWith(
      expect.objectContaining({ revert: 12, merge: "merged" }),
      "steering-repo.repair: handled the revert pull request",
    );
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it("goes on when the revert pull request is gone", async () => {
    const host = fakeHost({ mergeRevert: vi.fn(async () => ({ kind: "gone" }) as const) });
    const deps = fakeDeps({
      host,
      rows: [row("diverged", { revertPrNumber: 12, publishedVersion: null })],
      outcomes: [outcome("diverged")],
    });

    expect(await repair(SCOPE, INPUT, deps)).toEqual({ health: "diverged" });
    expect(host.mergeRevert).toHaveBeenCalledWith(12, { sha: PUBLISHED.sha, version: null });
  });

  it("reads the health and refuses when the host will not merge the revert", async () => {
    const host = fakeHost({
      mergeRevert: vi.fn(
        async () => ({ kind: "refused", message: "Head branch was modified." }) as const,
      ),
    });
    const deps = fakeDeps({
      host,
      rows: [row("diverged", { revertPrNumber: 12 })],
      outcomes: [outcome("diverged")],
    });

    await expect(repair(SCOPE, INPUT, deps)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_revert_refused",
      message:
        "Oxagen could not merge #12, which puts main back at the published version: Head branch was modified. Select Repair settings again.",
    });
    expect(deps.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    ["no revert pull request", { revertPrNumber: null }],
    ["no published commit", { revertPrNumber: 12, publishedSha: null }],
  ])("skips the merge of a diverged repo with %s", async (_, over) => {
    const host = fakeHost();
    const deps = fakeDeps({ host, rows: [row("diverged", over)] });

    await repair(SCOPE, INPUT, deps);

    expect(host.mergeRevert).not.toHaveBeenCalled();
  });

  it("skips the merge when a drifted repo has a revert number from before", async () => {
    const host = fakeHost();
    const deps = fakeDeps({ host, rows: [row("drifted", { revertPrNumber: 12 })] });

    await repair(SCOPE, INPUT, deps);

    expect(host.mergeRevert).not.toHaveBeenCalled();
  });

  it("refuses when the final read finds no steering repo", async () => {
    const deps = fakeDeps({ outcomes: [null] });

    await expect(repair(SCOPE, INPUT, deps)).rejects.toMatchObject({
      code: "not_found",
      reason: "steering_repo_not_ready",
    });
  });
});

// ── GitHub ───────────────────────────────────────────────────────────────────

const ROOT = "/repos/acme/steering";

describe("githubRepairHost.applyBaseline", () => {
  it("puts back a ruleset someone renamed away", async () => {
    const { hub, id } = await baselineRepo();
    const rest = hub.appRest();
    const list = await rest.request<{ id: number; name: string }[]>("GET", `${ROOT}/rulesets`);
    const merges = list.data?.find((r) => r.name === "Oxagen merges");
    if (merges === undefined) throw new Error("The baseline has no Oxagen merges ruleset.");
    await rest.request("PUT", `${ROOT}/rulesets/${merges.id}`, { name: "Old merges" });
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const host = githubRepairHost({
      rest: async () => gh.createGithubRest({ token: "app-token", fetch }),
      app: APP,
      repositoryId: id,
      address: REPO,
    });

    expect(await host.applyBaseline()).toEqual([]);

    const after = await gh.readSettings(
      hub.appRest(),
      REPO,
      APP,
      Object.keys(GITHUB_SETTINGS_BASELINE.environments),
    );
    expect(gh.compareSettings(GITHUB_SETTINGS_BASELINE, after)).toEqual([]);
  });

  it("finds the repository by id after a rename and writes it at its new name", async () => {
    const { hub, id } = await baselineRepo();
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const host = githubRepairHost({
      rest: async () => gh.createGithubRest({ token: "app-token", fetch }),
      app: APP,
      repositoryId: id,
      address: { owner: "acme", name: "old-name" },
    });

    expect(host.name()).toBe("acme/old-name");
    expect(await host.applyBaseline()).toEqual([]);
    expect(host.name()).toBe("acme/steering");
    expect(hub.calls.some((c) => c.path.includes("old-name"))).toBe(false);
  });

  it("throws when GitHub no longer shows the repository", async () => {
    const { hub, id } = await baselineRepo();
    const fetch = withRepositories(hub, new Map());
    const host = githubRepairHost({
      rest: async () => gh.createGithubRest({ token: "app-token", fetch }),
      app: APP,
      repositoryId: id,
      address: REPO,
    });

    await expect(host.applyBaseline()).rejects.toMatchObject({ status: 404 });
  });

  it("mints one client for every call", async () => {
    const { hub, id } = await baselineRepo();
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const rest = vi.fn(async () => gh.createGithubRest({ token: "app-token", fetch }));
    const host = githubRepairHost({ rest, app: APP, repositoryId: id, address: REPO });

    await host.applyBaseline();
    await host.applyBaseline();

    expect(rest).toHaveBeenCalledOnce();
  });
});

describe("githubRepairHost.mergeRevert", () => {
  const PULL = `GET ${ROOT}/pulls/12`;
  const MERGE = `PUT ${ROOT}/pulls/12/merge`;
  const OPEN_REVERT = { number: 12, state: "open", head: { ref: REVERT_REF, sha: HEAD } };

  function scripted(routes: Parameters<typeof server>[1]) {
    const s = server(GITHUB_BASE, routes);
    const rest = gh.createGithubRest({ token: "app-token", fetch: s.fetch });
    return {
      s,
      host: githubRepairHost({ rest: async () => rest, app: APP, repositoryId: 1, address: REPO }),
    };
  }

  it("squash merges the revert at the head it read, with the trailer", async () => {
    const { s, host } = scripted({ [PULL]: ok(OPEN_REVERT), [MERGE]: ok({ merged: true }) });

    expect(await host.mergeRevert(12, PUBLISHED)).toEqual({ kind: "merged" });
    expect(s.writes()).toEqual([
      {
        method: "PUT",
        path: `${ROOT}/pulls/12/merge`,
        body: {
          merge_method: "squash",
          sha: HEAD,
          commit_title: revertTitle(7),
          commit_message: `${REVERT_TRAILER}: ${PUBLISHED.sha}`,
        },
      },
    ]);
  });

  it.each([
    ["missing", fail(404, "Not Found")],
    ["closed", ok({ ...OPEN_REVERT, state: "closed" })],
    ["not a revert", ok({ ...OPEN_REVERT, head: { ref: "feature/rules", sha: HEAD } })],
  ])("reads a pull request that is %s as gone and merges nothing", async (_, reply) => {
    const { s, host } = scripted({ [PULL]: reply });

    expect(await host.mergeRevert(12, PUBLISHED)).toEqual({ kind: "gone" });
    expect(s.writes()).toEqual([]);
  });

  it.each([405, 409, 422])("reads a %s answer to the merge as refused", async (status) => {
    const { host } = scripted({
      [PULL]: ok(OPEN_REVERT),
      [MERGE]: fail(status, "Head branch was modified."),
    });

    expect(await host.mergeRevert(12, PUBLISHED)).toEqual({
      kind: "refused",
      message: "Head branch was modified.",
    });
  });

  it("reads a merge GitHub did not make as refused", async () => {
    const { host } = scripted({ [PULL]: ok(OPEN_REVERT), [MERGE]: ok({ merged: false }) });

    expect(await host.mergeRevert(12, PUBLISHED)).toEqual({
      kind: "refused",
      message: "GitHub answered 200.",
    });
  });

  it("throws on a refused read of the pull request", async () => {
    const { host } = scripted({ [PULL]: fail(403, "Resource not accessible by integration") });

    await expect(host.mergeRevert(12, PUBLISHED)).rejects.toBeInstanceOf(GitHubApiError);
  });
});

// ── GitLab ───────────────────────────────────────────────────────────────────

describe("gitlabRepairHost.applyBaseline", () => {
  it("puts back a protected branch someone removed", async () => {
    const { lab, id } = await baselineProject();
    await lab.rest().request("DELETE", `/projects/${id}/protected_branches/main`);
    const host = gitlabRepairHost({
      rest: async () => lab.rest(),
      projectId: id,
      path: "acme/steering",
    });

    expect(await host.applyBaseline()).toEqual([]);

    const after = await gl.readGitlabSettings(lab.rest(), id, BOT);
    expect(gl.compareGitlabSettings(GITLAB_SETTINGS_BASELINE, after, BOT)).toEqual([]);
  });

  it("names the project by its path", () => {
    const host = gitlabRepairHost({ rest: async () => null, projectId: 1, path: "acme/steering" });
    expect(host.name()).toBe("acme/steering");
  });

  it("refuses when no group token is stored", async () => {
    const host = gitlabRepairHost({ rest: async () => null, projectId: 1, path: "acme/steering" });

    await expect(host.applyBaseline()).rejects.toBeInstanceOf(gl.SteeringGitlabReauthorizeError);
  });
});

describe("gitlabRepairHost.mergeRevert", () => {
  const REQUEST = "GET /projects/1/merge_requests/3";
  const MERGE = "PUT /projects/1/merge_requests/3/merge";
  const OPEN_REVERT = { iid: 3, state: "opened", sha: HEAD, source_branch: REVERT_REF };

  function scripted(routes: Parameters<typeof server>[1]) {
    const s = server(GITLAB_BASE, routes);
    const rest = gl.createGitlabRest({ token: "group-token", fetch: s.fetch });
    return {
      s,
      host: gitlabRepairHost({ rest: async () => rest, projectId: 1, path: "acme/steering" }),
    };
  }

  it("squash merges the revert at the head it read, with the trailer", async () => {
    const { s, host } = scripted({ [REQUEST]: ok(OPEN_REVERT), [MERGE]: ok({ state: "merged" }) });

    expect(await host.mergeRevert(3, PUBLISHED)).toEqual({ kind: "merged" });
    expect(s.writes()).toEqual([
      {
        method: "PUT",
        path: "/projects/1/merge_requests/3/merge",
        body: {
          sha: HEAD,
          squash: true,
          squash_commit_message: revertMessage(PUBLISHED),
          should_remove_source_branch: true,
        },
      },
    ]);
  });

  it.each([
    ["missing", fail(404, "404 Not found")],
    ["merged", ok({ ...OPEN_REVERT, state: "merged" })],
    ["not a revert", ok({ ...OPEN_REVERT, source_branch: "feature/rules" })],
  ])("reads a merge request that is %s as gone and merges nothing", async (_, reply) => {
    const { s, host } = scripted({ [REQUEST]: reply });

    expect(await host.mergeRevert(3, PUBLISHED)).toEqual({ kind: "gone" });
    expect(s.writes()).toEqual([]);
  });

  it.each([405, 406, 409, 422])("reads a %s answer to the merge as refused", async (status) => {
    const { host } = scripted({
      [REQUEST]: ok(OPEN_REVERT),
      [MERGE]: fail(status, "Branch cannot be merged"),
    });

    expect(await host.mergeRevert(3, PUBLISHED)).toEqual({
      kind: "refused",
      message: "Branch cannot be merged",
    });
  });

  it("reads a merge GitLab left open as refused", async () => {
    const { host } = scripted({ [REQUEST]: ok(OPEN_REVERT), [MERGE]: ok({ state: "opened" }) });

    expect(await host.mergeRevert(3, PUBLISHED)).toEqual({
      kind: "refused",
      message: "GitLab answered 200.",
    });
  });
});

// ── Production ───────────────────────────────────────────────────────────────

const APP_ENV = {
  OXAGEN_STEERING_APP_ID: "4242",
  OXAGEN_STEERING_APP_PRIVATE_KEY: "private-key",
  OXAGEN_STEERING_APP_SLUG: "oxagen-steering",
};
const GITHUB_CONNECTION: SteeringConnection = {
  provider: "github",
  installation_id: 77,
  account_login: "acme",
};
const GITLAB_CONNECTION: SteeringConnection = {
  provider: "gitlab",
  group_id: 7,
  group_path: "acme",
};

describe("repairHostFor", () => {
  it("refuses every write to a target with no connection", async () => {
    const host = repairHostFor(located("github", null), APP_ENV);
    const message =
      "Oxagen can no longer reach the steering repo acme/steering. An organization admin must connect it again.";

    expect(host?.name()).toBe("acme/steering");
    await expect(host?.applyBaseline()).rejects.toMatchObject({
      reason: "steering_repo_disconnected",
      message,
    });
    await expect(host?.mergeRevert(12, PUBLISHED)).rejects.toMatchObject({
      reason: "steering_repo_disconnected",
      message,
    });
  });

  it("returns null when the deployment has no Oxagen Steering app", () => {
    expect(repairHostFor(located("github", GITHUB_CONNECTION), {})).toBeNull();
  });

  it("writes GitHub through the installation", async () => {
    const { hub } = await baselineRepo();
    const fetch = withRepositories(hub, new Map([[1, REPO]]));
    vi.mocked(steeringInstallationRest).mockResolvedValue(
      gh.createGithubRest({ token: "app-token", fetch }),
    );
    const host = repairHostFor(located("github", GITHUB_CONNECTION), APP_ENV);

    expect(await host?.applyBaseline()).toEqual([]);
    expect(steeringInstallationRest).toHaveBeenCalledWith(
      { app: APP, privateKey: "private-key" },
      77,
    );
  });

  it("refuses GitLab when no group token is stored", async () => {
    vi.mocked(steeringGroupToken).mockResolvedValue(null);
    const host = repairHostFor(located("gitlab", GITLAB_CONNECTION), {});

    expect(host?.name()).toBe("acme/steering");
    await expect(host?.applyBaseline()).rejects.toBeInstanceOf(gl.SteeringGitlabReauthorizeError);
    expect(steeringGroupToken).toHaveBeenCalledWith("org-1", 7);
  });

  it("sends the stored group token to GitLab", async () => {
    const s = server(GITLAB_BASE, { "GET /projects/1/merge_requests/3": fail(404, "404 Not found") });
    vi.stubGlobal("fetch", s.fetch);
    vi.mocked(steeringGroupToken).mockResolvedValue("group-token");
    const host = repairHostFor(located("gitlab", GITLAB_CONNECTION), {});

    expect(await host?.mergeRevert(3, PUBLISHED)).toEqual({ kind: "gone" });
    expect(s.calls).toHaveLength(1);
  });
});

describe("productionRepairDeps", () => {
  it("reads and writes through the health store and the production hosts", async () => {
    const deps = productionRepairDeps({});

    expect(deps.locate).toBe(loadHealthTarget);
    expect(deps.loadRow).toBe(productionHealthStorage.loadRow);
    expect(deps.refresh).toBe(refreshRepoHealth);
    expect(deps.now()).toBeInstanceOf(Date);
    expect(await deps.host(located("github", GITHUB_CONNECTION))).toBeNull();
  });
});
