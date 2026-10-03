// health.hosts.test.ts: the GitHub and GitLab health hosts, the host a
// deployment picks for a target, and the notification text. Settings reads go
// through the fake GitHub and GitLab the provisioning tests use. Pull request,
// check, and comment calls go through a scripted server. Both run the real
// REST clients.
import { GitHubApiError, GitHubRateLimitedError } from "@oxagen/github";
import * as gh from "@oxagen/github/provision";
import { FakeGithub } from "@oxagen/github/provision/testing";
import * as gl from "@oxagen/gitlab/provision";
import { REQUIRED_CHECK_NAME } from "@oxagen/oxagen/steering-repo";
import { describe, expect, it, vi } from "vitest";
import {
  type SteeringConnection,
  steeringGroupToken,
  steeringInstallationRest,
} from "../steering_repo.provision";
import {
  APP,
  BOT,
  baselineProject,
  baselineRepo,
  REPO,
  withRepositories,
} from "./__tests__/fakes";
import { fail, GITHUB_BASE, GITLAB_BASE, ok, server } from "./__tests__/scripted-http";
import * as history from "./diverged";
import {
  type Divergence,
  HEALTH_CHECK_EXTERNAL_ID,
  HEALTH_COMMENT_MARKER,
  type HealthReport,
  type HealthState,
  type OpenPullRequest,
  type PublishedCommit,
} from "./health";
import {
  githubHealthHost,
  gitlabHealthHost,
  HEALTH_STATUS_PREFIX,
  healthEmailHtml,
  healthHostFor,
  healthNotificationTitle,
  type LocatedTarget,
  notifyAdmins,
  unconnectedHealthHost,
} from "./health.hosts";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  calls: [] as string[],
  notifyOrgManagers: vi.fn(),
  notifyOrgSlack: vi.fn(),
}));

// The notice senders have their own tests in @oxagen/notifications. Here they
// only need to receive the right notice, in the right order.
vi.mock("@oxagen/notifications", () => ({
  notifyOrgManagers: mocks.notifyOrgManagers,
  notifyOrgSlack: mocks.notifyOrgSlack,
}));

vi.mock("../logger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger")>()),
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../steering_repo.provision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../steering_repo.provision")>()),
  steeringInstallationRest: vi.fn(),
  steeringGroupToken: vi.fn(),
}));

// The history calls have their own tests in diverged.test.ts. Here they only
// need to receive the right target.
vi.mock("./diverged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diverged")>()),
  githubPublished: vi.fn(),
  githubDiverged: vi.fn(),
  githubOpenRevert: vi.fn(),
  githubCloseRevert: vi.fn(),
  gitlabPublished: vi.fn(),
  gitlabDiverged: vi.fn(),
  gitlabOpenRevert: vi.fn(),
  gitlabCloseRevert: vi.fn(),
}));

const ROOT = "/repos/acme/steering";
const SHA = "ab".repeat(20);
const PR: OpenPullRequest = { number: 11, head_sha: SHA, head_ref: "feature/rules" };
const REVERT_REF = "steering/revert-to-a1a1a1a-d4d4d4d";
const PUBLISHED: PublishedCommit = { sha: "a1".repeat(20), version: 7 };
const DIVERGENCE: Divergence = {
  reason: "main holds 1 commit Oxagen did not merge: c3c3c3c",
  main_sha: "d4".repeat(20),
};
const REPORT: HealthReport = {
  title: "Settings changed on the steering repo",
  summary: "The ruleset Oxagen merges was deleted.",
  comment: `${HEALTH_COMMENT_MARKER}\nThe ruleset Oxagen merges was deleted.`,
  digest: "digest-1",
};
const DETAILS = "https://app.oxagen.sh/acme/main/repositories";

// ── GitHub ───────────────────────────────────────────────────────────────────

function githubHost(
  rest: () => Promise<gh.GithubRest>,
  opts: { repositoryId?: number; address?: gh.RepoAddress; detailsUrl?: string | null } = {},
) {
  return githubHealthHost({
    rest,
    app: APP,
    repositoryId: opts.repositoryId ?? 1,
    address: opts.address ?? REPO,
    account: "acme",
    detailsUrl: opts.detailsUrl === undefined ? DETAILS : opts.detailsUrl,
  });
}

/** A GitHub host over a scripted server. */
function scriptedGithub(
  routes: Parameters<typeof server>[1],
  opts: { detailsUrl?: string | null } = {},
) {
  const s = server(GITHUB_BASE, routes);
  const rest = gh.createGithubRest({ token: "app-token", fetch: s.fetch });
  return { s, rest, host: githubHost(async () => rest, opts) };
}

describe("githubHealthHost.observe", () => {
  it("reads a repo at the baseline as connected with no differences", async () => {
    const { hub, id } = await baselineRepo();
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const host = githubHost(async () => gh.createGithubRest({ token: "app-token", fetch }), {
      repositoryId: id,
    });

    expect(await host.observe()).toEqual({
      kind: "connected",
      repository: "acme/steering",
      differences: [],
    });
  });

  it("stays connected when private repository protection endpoints require a paid plan", async () => {
    const { hub, id } = await baselineRepo();
    hub.failNext({
      path: /\/(?:rulesets|environments)(?:[/?]|$)/,
      status: 403,
      message: "Upgrade your GitHub plan to use this feature.",
    });
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const host = githubHost(async () => gh.createGithubRest({ token: "app-token", fetch }), {
      repositoryId: id,
    });

    expect(await host.observe()).toMatchObject({ kind: "connected", differences: [] });
    expect(hub.calls.some((call) => /\/(?:rulesets|environments)(?:[/?]|$)/.test(call.path))).toBe(false);
  });

  it("reports a changed merge setting", async () => {
    const { hub, id } = await baselineRepo();
    const rest = hub.appRest();
    await rest.request("PATCH", ROOT, { allow_rebase_merge: true });
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const host = githubHost(async () => gh.createGithubRest({ token: "app-token", fetch }), {
      repositoryId: id,
    });

    const seen = await host.observe();

    if (seen.kind !== "connected") throw new Error(`Expected connected, got ${seen.reason}`);
    expect(seen.differences).toContainEqual(
      expect.objectContaining({ setting: "merge.allow_rebase_merge", expected: false, actual: true }),
    );
  });

  it("finds the repository by id after a rename and reads it at its new name", async () => {
    const { hub, id } = await baselineRepo();
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const host = githubHost(async () => gh.createGithubRest({ token: "app-token", fetch }), {
      repositoryId: id,
      address: { owner: "acme", name: "old-name" },
    });

    expect(await host.observe()).toMatchObject({ kind: "connected", repository: "acme/steering" });
    expect(hub.calls.some((c) => c.path.includes("old-name"))).toBe(false);
    expect(hub.calls).toContainEqual({ method: "GET", path: ROOT });
  });

  it("reads a repository GitHub no longer shows as deleted", async () => {
    const { hub, id } = await baselineRepo();
    const fetch = withRepositories(hub, new Map());
    const host = githubHost(async () => gh.createGithubRest({ token: "app-token", fetch }), {
      repositoryId: id,
    });

    expect(await host.observe()).toEqual({
      kind: "disconnected",
      reason: "The repository acme/steering was deleted, or the Oxagen GitHub App can no longer see it.",
    });
  });

  it("reads a refused settings read as disconnected", async () => {
    const { hub, id } = await baselineRepo();
    hub.failNext({
      path: "/actions/permissions",
      status: 403,
      message: "Resource not accessible by integration",
    });
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const host = githubHost(async () => gh.createGithubRest({ token: "app-token", fetch }), {
      repositoryId: id,
    });

    expect(await host.observe()).toEqual({
      kind: "disconnected",
      reason: "GitHub refused to show the Oxagen GitHub App the settings of acme/steering.",
    });
  });

  it("throws on a rate limit so the job retries and stores nothing", async () => {
    const { hub, id } = await baselineRepo();
    hub.failNext({ path: "/actions/permissions", status: 429, message: "slow down" });
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const host = githubHost(async () => gh.createGithubRest({ token: "app-token", fetch }), {
      repositoryId: id,
    });

    await expect(host.observe()).rejects.toBeInstanceOf(GitHubRateLimitedError);
  });

  it("throws on a rate limit when GitHub looks the repository up", async () => {
    const hub = new FakeGithub({ org: "acme", app: APP });
    const fetch = withRepositories(hub, new Map(), {
      status: 403,
      body: { message: "API rate limit exceeded for installation" },
    });
    const host = githubHost(async () => gh.createGithubRest({ token: "app-token", fetch }));

    await expect(host.observe()).rejects.toBeInstanceOf(GitHubRateLimitedError);
  });

  it("throws on a server error", async () => {
    const { hub, id } = await baselineRepo();
    hub.failNext({ path: "/actions/permissions", status: 502, message: "Bad gateway" });
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const host = githubHost(async () => gh.createGithubRest({ token: "app-token", fetch }), {
      repositoryId: id,
    });

    await expect(host.observe()).rejects.toBeInstanceOf(GitHubApiError);
  });

  it("reads an uninstalled app as disconnected", async () => {
    const host = githubHost(() =>
      Promise.reject(new Error("GitHub App token mint failed (404): Not Found")),
    );
    expect(await host.observe()).toEqual({
      kind: "disconnected",
      reason: "The Oxagen GitHub App is no longer installed on acme.",
    });
  });

  it("reads a suspended installation as disconnected", async () => {
    const host = githubHost(() =>
      Promise.reject(new Error("GitHub App token mint failed (403): This installation has been suspended")),
    );
    expect(await host.observe()).toEqual({
      kind: "disconnected",
      reason: "The Oxagen GitHub App installation on acme is suspended.",
    });
  });

  it("throws any other mint failure", async () => {
    const host = githubHost(() =>
      Promise.reject(new Error("GitHub App token mint failed (500): Internal error")),
    );
    await expect(host.observe()).rejects.toThrow("token mint failed (500)");
    const bad = githubHost(() => Promise.reject(new Error("A key that does not parse")));
    await expect(bad.observe()).rejects.toThrow("A key that does not parse");
  });

  it("mints one token per host", async () => {
    const { hub, id } = await baselineRepo();
    const fetch = withRepositories(hub, new Map([[id, REPO]]));
    const mint = vi.fn(async () => gh.createGithubRest({ token: "app-token", fetch }));
    const host = githubHost(mint, { repositoryId: id });

    await host.observe();
    await host.observe();

    expect(mint).toHaveBeenCalledTimes(1);
  });
});

describe("githubHealthHost history", () => {
  it("hands each history call the repository it read last", async () => {
    const { rest, host } = scriptedGithub({});
    const target = { rest, repo: { ...REPO, id: 1 }, app: APP };
    vi.mocked(history.githubPublished).mockResolvedValue(PUBLISHED);
    vi.mocked(history.githubDiverged).mockResolvedValue(DIVERGENCE);
    vi.mocked(history.githubOpenRevert).mockResolvedValue(13);
    vi.mocked(history.githubCloseRevert).mockResolvedValue(undefined);

    expect(await host.published()).toEqual(PUBLISHED);
    expect(await host.diverged(PUBLISHED)).toEqual(DIVERGENCE);
    expect(await host.openRevert(PUBLISHED, DIVERGENCE, 12)).toBe(13);
    await host.closeRevert(12);

    expect(history.githubPublished).toHaveBeenCalledWith(target);
    expect(history.githubDiverged).toHaveBeenCalledWith(target, PUBLISHED);
    expect(history.githubOpenRevert).toHaveBeenCalledWith(target, PUBLISHED, DIVERGENCE, 12);
    expect(history.githubCloseRevert).toHaveBeenCalledWith(target, 12);
  });

  it("knows the revert pull request by its branch", () => {
    const { host } = scriptedGithub({});
    expect(host.isRevert({ ...PR, head_ref: REVERT_REF })).toBe(true);
    expect(host.isRevert(PR)).toBe(false);
  });
});

describe("githubHealthHost pull requests", () => {
  function pulls(from: number, count: number) {
    return Array.from({ length: count }, (_, i) => ({
      number: from + i,
      head: { sha: String(from + i).padStart(40, "0"), ref: `b${from + i}` },
    }));
  }

  it("reads every page of open pull requests", async () => {
    const { s, host } = scriptedGithub({
      [`GET ${ROOT}/pulls?state=open&per_page=100&page=1`]: ok(pulls(1, 100)),
      [`GET ${ROOT}/pulls?state=open&per_page=100&page=2`]: ok(pulls(101, 1)),
    });

    const open = await host.openPullRequests();

    expect(open.complete).toBe(true);
    expect(open.pulls).toHaveLength(101);
    expect(open.pulls[100]).toEqual({ number: 101, head_sha: pulls(101, 1)[0]?.head.sha, head_ref: "b101" });
    expect(s.calls).toHaveLength(2);
  });

  it("stops after ten pages and says the list is cut (#4653)", async () => {
    const { s, host } = scriptedGithub(
      Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [
          `GET ${ROOT}/pulls?state=open&per_page=100&page=${i + 1}`,
          ok(pulls(i * 100 + 1, 100)),
        ]),
      ),
    );

    const open = await host.openPullRequests();
    expect(open.pulls).toHaveLength(1000);
    expect(open.complete).toBe(false);
    expect(s.calls).toHaveLength(10);
  });

  it("fails the check with the report and a link to the repo in Oxagen", async () => {
    const { s, host } = scriptedGithub({ [`POST ${ROOT}/check-runs`]: ok({ id: 1 }, 201) });

    await host.failCheck(PR, REPORT);

    expect(s.writes()).toEqual([
      {
        method: "POST",
        path: `${ROOT}/check-runs`,
        body: {
          name: REQUIRED_CHECK_NAME,
          head_sha: SHA,
          status: "completed",
          conclusion: "failure",
          external_id: HEALTH_CHECK_EXTERNAL_ID,
          details_url: DETAILS,
          output: { title: REPORT.title, summary: REPORT.summary },
        },
      },
    ]);
  });

  it("fails the check without a link when the deployment has no app URL", async () => {
    const { s, host } = scriptedGithub(
      { [`POST ${ROOT}/check-runs`]: ok({ id: 1 }, 201) },
      { detailsUrl: null },
    );

    await host.failCheck(PR, REPORT);

    expect(s.writes()[0]?.body).not.toHaveProperty("details_url");
  });
});

describe("githubHealthHost.restoreCheck", () => {
  const RUNS = `GET ${ROOT}/commits/${SHA}/check-runs?check_name=Oxagen%20steering&app_id=4242&filter=all&per_page=100`;

  it("reposts the newest result the steering checks finished", async () => {
    const { s, host } = scriptedGithub({
      [RUNS]: ok({
        check_runs: [
          { id: 3, status: "completed", conclusion: "failure", output: { title: "Old", summary: "old" } },
          {
            id: 5,
            status: "completed",
            conclusion: "success",
            details_url: "https://app.oxagen.sh/runs/5",
            output: { title: "Checks passed", summary: "All checks passed." },
          },
          { id: 8, status: "in_progress", conclusion: null },
          {
            id: 9,
            status: "completed",
            conclusion: "failure",
            external_id: HEALTH_CHECK_EXTERNAL_ID,
            output: { title: REPORT.title, summary: REPORT.summary },
          },
        ],
      }),
      [`POST ${ROOT}/check-runs`]: ok({ id: 10 }, 201),
    });

    await host.restoreCheck(PR);

    expect(s.writes()).toEqual([
      {
        method: "POST",
        path: `${ROOT}/check-runs`,
        body: {
          name: REQUIRED_CHECK_NAME,
          head_sha: SHA,
          status: "completed",
          conclusion: "success",
          details_url: "https://app.oxagen.sh/runs/5",
          output: { title: "Checks passed", summary: "All checks passed." },
        },
      },
    ]);
  });

  it("fills in a title when the result had no output", async () => {
    const { s, host } = scriptedGithub({
      [RUNS]: ok({ check_runs: [{ id: 4, status: "completed", conclusion: "neutral", output: null }] }),
      [`POST ${ROOT}/check-runs`]: ok({ id: 10 }, 201),
    });

    await host.restoreCheck(PR);

    expect(s.writes()[0]?.body).toEqual({
      name: REQUIRED_CHECK_NAME,
      head_sha: SHA,
      status: "completed",
      conclusion: "neutral",
      output: { title: "Steering checks", summary: "" },
    });
  });

  it("posts nothing when the steering checks never finished on the head", async () => {
    const { s, host } = scriptedGithub({
      [RUNS]: ok({
        check_runs: [
          { id: 9, status: "completed", conclusion: "failure", external_id: HEALTH_CHECK_EXTERNAL_ID },
        ],
      }),
    });

    await host.restoreCheck(PR);

    expect(s.writes()).toEqual([]);
  });

  /** A full page of health runs, newest first, with ids from `top` down. */
  function healthRuns(top: number) {
    return Array.from({ length: 100 }, (_, i) => ({
      id: top - i,
      status: "completed",
      conclusion: "failure",
      external_id: HEALTH_CHECK_EXTERNAL_ID,
    }));
  }

  it("finds the steering checks' result on the second page (#4653)", async () => {
    const { s, host } = scriptedGithub({
      [RUNS]: ok({ check_runs: healthRuns(300) }),
      [`${RUNS}&page=2`]: ok({
        check_runs: [
          { id: 7, status: "completed", conclusion: "success", output: { title: "Checks passed", summary: "ok" } },
        ],
      }),
      [`POST ${ROOT}/check-runs`]: ok({ id: 301 }, 201),
    });

    await host.restoreCheck(PR);

    expect(s.writes()[0]?.body).toMatchObject({ conclusion: "success", head_sha: SHA });
  });

  it("throws when ten full pages hold only health runs, so the run retries (#4653)", async () => {
    const routes: Parameters<typeof server>[1] = { [RUNS]: ok({ check_runs: healthRuns(2000) }) };
    for (let page = 2; page <= 10; page++)
      routes[`${RUNS}&page=${page}`] = ok({ check_runs: healthRuns(2000 - (page - 1) * 100) });
    const { s, host } = scriptedGithub(routes);

    await expect(host.restoreCheck(PR)).rejects.toThrow(/more Oxagen steering results than Oxagen reads/);
    expect(s.writes()).toEqual([]);
  });
});

describe("githubHealthHost.upsertComment", () => {
  const COMMENTS = `GET ${ROOT}/issues/11/comments?per_page=100&page=1`;
  const BODY = `${HEALTH_COMMENT_MARKER}\nThe steering repo is not healthy.`;
  const someoneElse = { id: 1, body: `${HEALTH_COMMENT_MARKER} quoted`, user: { login: "dana" } };

  it("edits the app's comment in place", async () => {
    const { s, host } = scriptedGithub({
      [COMMENTS]: ok([
        someoneElse,
        { id: 2, body: `${HEALTH_COMMENT_MARKER}\nold`, performed_via_github_app: { slug: APP.slug } },
      ]),
      [`PATCH ${ROOT}/issues/comments/2`]: ok({ id: 2 }),
    });

    await host.upsertComment(PR, BODY, false);

    expect(s.writes()).toEqual([
      { method: "PATCH", path: `${ROOT}/issues/comments/2`, body: { body: BODY } },
    ]);
  });

  it("knows the app's comment by its bot login", async () => {
    const { s, host } = scriptedGithub({
      [COMMENTS]: ok([{ id: 3, body: `${HEALTH_COMMENT_MARKER}\nold`, user: { login: "oxagen-steering[bot]" } }]),
      [`PATCH ${ROOT}/issues/comments/3`]: ok({ id: 3 }),
    });

    await host.upsertComment(PR, BODY, true);

    expect(s.writes().map((w) => w.path)).toEqual([`${ROOT}/issues/comments/3`]);
  });

  it("leaves a comment that already says the same thing", async () => {
    const { s, host } = scriptedGithub({
      [COMMENTS]: ok([{ id: 2, body: BODY, performed_via_github_app: { slug: APP.slug } }]),
    });

    await host.upsertComment(PR, BODY, false);

    expect(s.writes()).toEqual([]);
  });

  it("posts a comment when the app has none, ignoring another user's marker", async () => {
    const { s, host } = scriptedGithub({
      [COMMENTS]: ok([someoneElse, { id: 4, body: null, user: null }]),
      [`POST ${ROOT}/issues/11/comments`]: ok({ id: 5 }, 201),
    });

    await host.upsertComment(PR, BODY, false);

    expect(s.writes()).toEqual([
      { method: "POST", path: `${ROOT}/issues/11/comments`, body: { body: BODY } },
    ]);
  });

  it("posts nothing on recovery when the pull request never had a comment", async () => {
    const { s, host } = scriptedGithub({ [COMMENTS]: ok([]) });

    await host.upsertComment(PR, BODY, true);

    expect(s.writes()).toEqual([]);
  });

  it("throws when GitHub refuses the comment", async () => {
    const { host } = scriptedGithub({
      [COMMENTS]: ok([]),
      [`POST ${ROOT}/issues/11/comments`]: fail(403, "Resource not accessible by integration"),
    });

    await expect(host.upsertComment(PR, BODY, false)).rejects.toBeInstanceOf(GitHubApiError);
  });
});

// ── GitLab ───────────────────────────────────────────────────────────────────

const GROUP_TOKEN_GONE =
  "No group access token is stored for acme. An organization admin must connect the group acme again.";

function gitlabHost(
  rest: () => Promise<gl.GitlabRest | null>,
  opts: { projectId?: number; detailsUrl?: string | null } = {},
) {
  return gitlabHealthHost({
    rest,
    projectId: opts.projectId ?? 1,
    group: "acme",
    path: "acme/steering",
    detailsUrl: opts.detailsUrl === undefined ? DETAILS : opts.detailsUrl,
  });
}

/** A GitLab host over a scripted server. */
function scriptedGitlab(
  routes: Parameters<typeof server>[1],
  opts: { detailsUrl?: string | null } = {},
) {
  const s = server(GITLAB_BASE, routes);
  const rest = gl.createGitlabRest({ token: "group-token", fetch: s.fetch });
  return { s, rest, host: gitlabHost(async () => rest, opts) };
}

describe("gitlabHealthHost.observe", () => {
  it("reads a project at the baseline as connected with no differences", async () => {
    const { lab, id } = await baselineProject();
    const host = gitlabHost(async () => lab.rest(), { projectId: id });

    expect(await host.observe()).toEqual({
      kind: "connected",
      repository: "acme/steering",
      differences: [],
    });
  });

  it("reports a protected branch someone removed", async () => {
    const { lab, id } = await baselineProject();
    await lab.rest().request("DELETE", `/projects/${id}/protected_branches/main`);
    const host = gitlabHost(async () => lab.rest(), { projectId: id });

    const seen = await host.observe();

    if (seen.kind !== "connected") throw new Error(`Expected connected, got ${seen.reason}`);
    expect(seen.differences.map((d) => d.setting)).toContain("protected_branches.main");
  });

  it("reads a missing group token as disconnected", async () => {
    const host = gitlabHost(async () => null);
    expect(await host.observe()).toEqual({ kind: "disconnected", reason: GROUP_TOKEN_GONE });
  });

  it("reads a revoked group token as disconnected", async () => {
    const { lab, id } = await baselineProject();
    lab.revokeToken();
    const host = gitlabHost(async () => lab.rest(), { projectId: id });

    expect(await host.observe()).toEqual({
      kind: "disconnected",
      reason:
        "GitLab refused the group access token for acme. An organization admin must connect the group acme again.",
    });
  });

  it("reads a project GitLab no longer shows as deleted", async () => {
    const { lab } = await baselineProject();
    const host = gitlabHost(async () => lab.rest(), { projectId: 999 });

    expect(await host.observe()).toEqual({
      kind: "disconnected",
      reason:
        "The project acme/steering was deleted, or the group access token can no longer see it.",
    });
  });

  it("reads a refused settings read as disconnected", async () => {
    const { lab, id } = await baselineProject();
    lab.failNext({ path: `/projects/${id}/protected_branches`, status: 403 });
    const host = gitlabHost(async () => lab.rest(), { projectId: id });

    expect(await host.observe()).toEqual({
      kind: "disconnected",
      reason: "GitLab refused to show the settings of acme/steering to the group access token.",
    });
  });

  it("throws on a rate limit and on a server error", async () => {
    const { lab, id } = await baselineProject();
    const host = gitlabHost(async () => lab.rest(), { projectId: id });

    lab.failNext({ path: `/projects/${id}/protected_branches`, status: 429 });
    await expect(host.observe()).rejects.toBeInstanceOf(gl.GitLabRateLimitedError);

    lab.failNext({ path: `/projects/${id}/protected_branches`, status: 500 });
    await expect(host.observe()).rejects.toBeInstanceOf(gl.GitLabApiError);
  });
});

describe("gitlabHealthHost history", () => {
  it("hands each history call the project and the bot", async () => {
    const { rest, host } = scriptedGitlab({ "GET /user": ok({ id: 99, username: "group_7_bot" }) });
    const target = { rest, projectId: 1, bot: BOT };
    vi.mocked(history.gitlabPublished).mockResolvedValue(PUBLISHED);
    vi.mocked(history.gitlabDiverged).mockResolvedValue(null);
    vi.mocked(history.gitlabOpenRevert).mockResolvedValue(4);
    vi.mocked(history.gitlabCloseRevert).mockResolvedValue(undefined);

    expect(await host.published()).toEqual(PUBLISHED);
    expect(await host.diverged(PUBLISHED)).toBeNull();
    expect(await host.openRevert(PUBLISHED, DIVERGENCE, null)).toBe(4);
    await host.closeRevert(3);

    expect(history.gitlabPublished).toHaveBeenCalledWith(target);
    expect(history.gitlabDiverged).toHaveBeenCalledWith(target, PUBLISHED);
    expect(history.gitlabOpenRevert).toHaveBeenCalledWith(target, PUBLISHED, DIVERGENCE, null);
    expect(history.gitlabCloseRevert).toHaveBeenCalledWith(target, 3);
    expect(host.isRevert({ number: 4, head_sha: SHA, head_ref: REVERT_REF })).toBe(true);
  });

  it("refuses every call but a read when no group token is stored", async () => {
    const host = gitlabHost(async () => null);
    await expect(host.openPullRequests()).rejects.toThrow(
      "No group access token is stored for acme.",
    );
    await expect(host.published()).rejects.toThrow("No group access token is stored for acme.");
  });
});

describe("gitlabHealthHost merge requests", () => {
  const MRS = "GET /projects/1/merge_requests?state=opened&per_page=100&page=1";
  const STATUS = `POST /projects/1/statuses/${SHA}`;

  it("reads open merge requests by iid", async () => {
    const { host } = scriptedGitlab({
      [MRS]: ok([{ iid: 3, sha: SHA, source_branch: "feature/rules" }]),
    });

    expect(await host.openPullRequests()).toEqual({
      pulls: [{ number: 3, head_sha: SHA, head_ref: "feature/rules" }],
      complete: true,
    });
  });

  it("fails the status with the report title and a link", async () => {
    const { s, host } = scriptedGitlab({ [STATUS]: ok({ id: 1 }, 201) });

    await host.failCheck(PR, REPORT);

    expect(s.writes()).toEqual([
      {
        method: "POST",
        path: `/projects/1/statuses/${SHA}`,
        body: {
          state: "failed",
          name: REQUIRED_CHECK_NAME,
          description: `${HEALTH_STATUS_PREFIX}${REPORT.title}`,
          target_url: DETAILS,
        },
      },
    ]);
  });

  it("cuts a long description to GitLab's limit and accepts a repeated status", async () => {
    const { s, host } = scriptedGitlab(
      { [STATUS]: fail(400, "Cannot transition status via :drop from :failed") },
      { detailsUrl: null },
    );

    await host.failCheck(PR, { ...REPORT, title: "x".repeat(300) });

    const body = s.writes()[0]?.body as { description: string };
    expect(body.description).toHaveLength(255);
    expect(body.description.startsWith(HEALTH_STATUS_PREFIX)).toBe(true);
    expect(body.description.endsWith("...")).toBe(true);
    expect(body).not.toHaveProperty("target_url");
  });
});

describe("gitlabHealthHost.restoreCheck", () => {
  const STATUSES = `GET /projects/1/repository/commits/${SHA}/statuses?name=Oxagen%20steering&all=true&per_page=100`;
  const STATUS = `POST /projects/1/statuses/${SHA}`;

  it("reposts the newest status the steering checks posted", async () => {
    const { s, host } = scriptedGitlab({
      [STATUSES]: ok([
        { id: 2, status: "failed", description: "Two checks failed." },
        {
          id: 5,
          status: "success",
          description: "All checks passed.",
          target_url: "https://app.oxagen.sh/runs/5",
        },
        { id: 7, status: "created", description: "Queued." },
        { id: 9, status: "failed", description: `${HEALTH_STATUS_PREFIX}${REPORT.title}` },
      ]),
      [STATUS]: ok({ id: 10 }, 201),
    });

    await host.restoreCheck(PR);

    expect(s.writes()).toEqual([
      {
        method: "POST",
        path: `/projects/1/statuses/${SHA}`,
        body: {
          state: "success",
          name: REQUIRED_CHECK_NAME,
          description: "All checks passed.",
          target_url: "https://app.oxagen.sh/runs/5",
        },
      },
    ]);
  });

  it("reposts a bare status as it was", async () => {
    const { s, host } = scriptedGitlab({
      [STATUSES]: ok([{ id: 4, status: "pending", description: null }]),
      [STATUS]: ok({ id: 10 }, 201),
    });

    await host.restoreCheck(PR);

    expect(s.writes()[0]?.body).toEqual({ state: "pending", name: REQUIRED_CHECK_NAME });
  });

  it("posts nothing when the steering checks never posted on the head", async () => {
    const { s, host } = scriptedGitlab({
      [STATUSES]: ok([{ id: 9, status: "failed", description: `${HEALTH_STATUS_PREFIX}x` }]),
    });

    await host.restoreCheck(PR);

    expect(s.writes()).toEqual([]);
  });

  it("finds the steering checks' status on the second page (#4653)", async () => {
    const health = Array.from({ length: 100 }, (_, i) => ({
      id: 300 - i,
      status: "failed",
      description: `${HEALTH_STATUS_PREFIX}x`,
    }));
    const { s, host } = scriptedGitlab({
      [STATUSES]: ok(health),
      [`${STATUSES}&page=2`]: ok([{ id: 7, status: "success", description: "All checks passed." }]),
      [STATUS]: ok({ id: 301 }, 201),
    });

    await host.restoreCheck(PR);

    expect(s.writes()[0]?.body).toEqual({
      state: "success",
      name: REQUIRED_CHECK_NAME,
      description: "All checks passed.",
    });
  });
});

describe("gitlabHealthHost.upsertComment", () => {
  const USER = { "GET /user": ok({ id: 99, username: "group_7_bot" }) };
  const NOTES = "GET /projects/1/merge_requests/11/notes?sort=asc&order_by=created_at&per_page=100&page=1";
  const BODY = `${HEALTH_COMMENT_MARKER}\nThe steering repo is not healthy.`;
  const someoneElse = { id: 1, body: `${HEALTH_COMMENT_MARKER} quoted`, author: { id: 5 } };

  it("edits the bot's note in place", async () => {
    const { s, host } = scriptedGitlab({
      ...USER,
      [NOTES]: ok([someoneElse, { id: 2, body: `${HEALTH_COMMENT_MARKER}\nold`, author: { id: 99 } }]),
      "PUT /projects/1/merge_requests/11/notes/2": ok({ id: 2 }),
    });

    await host.upsertComment(PR, BODY, false);

    expect(s.writes()).toEqual([
      { method: "PUT", path: "/projects/1/merge_requests/11/notes/2", body: { body: BODY } },
    ]);
  });

  it("leaves a note that already says the same thing", async () => {
    const { s, host } = scriptedGitlab({
      ...USER,
      [NOTES]: ok([{ id: 2, body: BODY, author: { id: 99 } }]),
    });

    await host.upsertComment(PR, BODY, false);

    expect(s.writes()).toEqual([]);
  });

  it("posts a note when the bot has none, ignoring another user's marker", async () => {
    const { s, host } = scriptedGitlab({
      ...USER,
      [NOTES]: ok([someoneElse, { id: 3, body: null, author: null }]),
      "POST /projects/1/merge_requests/11/notes": ok({ id: 4 }, 201),
    });

    await host.upsertComment(PR, BODY, false);

    expect(s.writes()).toEqual([
      { method: "POST", path: "/projects/1/merge_requests/11/notes", body: { body: BODY } },
    ]);
  });

  it("posts nothing on recovery when the merge request never had a note", async () => {
    const { s, host } = scriptedGitlab({ ...USER, [NOTES]: ok([]) });

    await host.upsertComment(PR, BODY, true);

    expect(s.writes()).toEqual([]);
  });
});

// ── Without a connection ─────────────────────────────────────────────────────

describe("unconnectedHealthHost", () => {
  it("reads as disconnected and refuses every write", async () => {
    const host = unconnectedHealthHost("No connection.");

    expect(await host.observe()).toEqual({ kind: "disconnected", reason: "No connection." });
    expect(host.isRevert({ ...PR, head_ref: REVERT_REF })).toBe(false);
    await expect(host.openPullRequests()).rejects.toThrow("No connection.");
    await expect(host.failCheck(PR, REPORT)).rejects.toThrow("No connection.");
    await expect(host.upsertComment(PR, "x", false)).rejects.toThrow("No connection.");
  });
});

// ── Host for a target ────────────────────────────────────────────────────────

const APP_ENV = {
  GITHUB_APP_ID: "4242",
  GITHUB_APP_PRIVATE_KEY: "private-key",
  GITHUB_APP_SLUG: "oxagen-steering",
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

function located(
  provider: "github" | "gitlab",
  connection: SteeringConnection | null,
): LocatedTarget {
  return {
    target: {
      scope: { orgId: "org-1", workspaceId: "ws-1" },
      provider,
      repository: { id: 1, full_name: "acme/steering" },
      deepLink: "/acme/main/repositories",
    },
    connection,
    owner: "acme",
    name: "steering",
  };
}

describe("healthHostFor", () => {
  it("reads a target with no connection as disconnected", async () => {
    const github = healthHostFor(located("github", null), APP_ENV);
    const gitlab = healthHostFor(located("gitlab", null), APP_ENV);

    expect(await github?.observe()).toEqual({
      kind: "disconnected",
      reason:
        "The organization no longer has a GitHub steering connection. An organization admin must connect it again.",
    });
    expect(await gitlab?.observe()).toEqual({
      kind: "disconnected",
      reason:
        "The organization no longer has a GitLab steering connection. An organization admin must connect it again.",
    });
  });

  it("returns null and logs when the deployment has no Oxagen GitHub App", () => {
    expect(healthHostFor(located("github", GITHUB_CONNECTION), {})).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(
      { orgId: "org-1", workspaceId: "ws-1" },
      expect.stringContaining("the Oxagen GitHub App is not configured"),
    );
  });

  it("reads GitHub through the installation and links checks to the app", async () => {
    const s = server(GITHUB_BASE, { [`POST ${ROOT}/check-runs`]: ok({ id: 1 }, 201) });
    vi.mocked(steeringInstallationRest).mockResolvedValue(
      gh.createGithubRest({ token: "app-token", fetch: s.fetch }),
    );
    const host = healthHostFor(located("github", GITHUB_CONNECTION), {
      ...APP_ENV,
      APP_URL: "https://app.oxagen.sh/",
    });

    await host?.failCheck(PR, REPORT);

    expect(steeringInstallationRest).toHaveBeenCalledWith(
      { app: APP, privateKey: "private-key" },
      77,
    );
    expect(s.writes()[0]?.body).toMatchObject({ details_url: DETAILS });
  });

  it("links checks from the public app URL when APP_URL is unset", async () => {
    const s = server(GITHUB_BASE, { [`POST ${ROOT}/check-runs`]: ok({ id: 1 }, 201) });
    vi.mocked(steeringInstallationRest).mockResolvedValue(
      gh.createGithubRest({ token: "app-token", fetch: s.fetch }),
    );
    const host = healthHostFor(located("github", GITHUB_CONNECTION), {
      ...APP_ENV,
      NEXT_PUBLIC_APP_URL: "https://app.oxagen.sh",
    });

    await host?.failCheck(PR, REPORT);

    expect(s.writes()[0]?.body).toMatchObject({ details_url: DETAILS });
  });

  it("reads GitLab through the group token", async () => {
    vi.mocked(steeringGroupToken).mockResolvedValue(null);
    const host = healthHostFor(located("gitlab", GITLAB_CONNECTION), {});

    expect(await host?.observe()).toEqual({ kind: "disconnected", reason: GROUP_TOKEN_GONE });
    expect(steeringGroupToken).toHaveBeenCalledWith("org-1", 7);
  });

  it("sends the stored group token to GitLab", async () => {
    const s = server(GITLAB_BASE, {
      "GET /projects/1/merge_requests?state=opened&per_page=100&page=1": ok([]),
    });
    vi.mocked(steeringGroupToken).mockResolvedValue("glpat-token");
    vi.stubGlobal("fetch", s.fetch);
    try {
      const host = healthHostFor(located("gitlab", GITLAB_CONNECTION), {});
      expect(await host?.openPullRequests()).toEqual({ pulls: [], complete: true });
      expect(s.calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── Notifications ────────────────────────────────────────────────────────────

function state(health: HealthState["health"]): HealthState {
  return {
    provider: "github",
    health,
    differences: [],
    reason: null,
    published_version: 7,
    revert_pr_number: null,
  };
}

describe("healthNotificationTitle", () => {
  it("names each state in one sentence", () => {
    expect(healthNotificationTitle(state("healthy"), "acme/steering")).toBe(
      "The steering repo acme/steering is healthy again",
    );
    expect(healthNotificationTitle(state("drifted"), "acme/steering")).toBe(
      "Settings changed on the steering repo acme/steering",
    );
    expect(healthNotificationTitle(state("disconnected"), "acme/steering")).toBe(
      "Oxagen lost access to the steering repo acme/steering",
    );
    expect(healthNotificationTitle(state("diverged"), "acme/steering")).toBe(
      "main on the steering repo acme/steering holds a commit Oxagen did not merge",
    );
  });
});

describe("healthEmailHtml", () => {
  it("escapes the text and keeps each line of the report", () => {
    expect(healthEmailHtml('Rules & "checks"', "Line <one>\nLine two")).toBe(
      "<p><strong>Rules &amp; &quot;checks&quot;</strong></p><p>Line &lt;one&gt;<br>Line two</p>",
    );
  });
});

describe("notifyAdmins", () => {
  const TARGET = located("github", null).target;
  const ENV = { APP_URL: "https://app.oxagen.sh" };

  function reset(): void {
    mocks.calls.length = 0;
    mocks.notifyOrgManagers.mockReset().mockImplementation(async () => {
      mocks.calls.push("managers");
    });
    mocks.notifyOrgSlack.mockReset().mockImplementation(async () => {
      mocks.calls.push("slack");
      return { outcome: "posted", channelId: "C1", ts: null };
    });
  }

  it("sends the in-app notice and email, then one Slack message with the same text", async () => {
    reset();
    await notifyAdmins(TARGET, state("drifted"), REPORT, ENV);
    const title = healthNotificationTitle(state("drifted"), "acme/steering");
    expect(mocks.calls).toEqual(["managers", "slack"]);
    expect(mocks.notifyOrgManagers).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      kind: "security",
      title,
      body: REPORT.summary,
      deepLink: "/acme/main/repositories",
      emailHtml: healthEmailHtml(title, REPORT.summary),
    });
    expect(mocks.notifyOrgSlack).toHaveBeenCalledTimes(1);
    expect(mocks.notifyOrgSlack).toHaveBeenCalledWith(
      {
        orgId: "org-1",
        workspaceId: "ws-1",
        kind: "security",
        title,
        body: REPORT.summary,
        deepLink: "/acme/main/repositories",
      },
      ENV,
    );
  });

  it("leaves out the workspace for the organization's own steering repo", async () => {
    reset();
    const target = { ...TARGET, scope: { orgId: "org-1", workspaceId: null } };
    await notifyAdmins(target, state("disconnected"), REPORT, ENV);
    expect(mocks.notifyOrgManagers.mock.calls[0]![0]).not.toHaveProperty("workspaceId");
    expect(mocks.notifyOrgSlack.mock.calls[0]![0]).not.toHaveProperty("workspaceId");
  });

  it("throws a failed Slack post, so the next health read sends the notice again", async () => {
    reset();
    const failure = new Error("Slack chat.postMessage failed: ratelimited");
    mocks.notifyOrgSlack.mockRejectedValueOnce(failure);
    await expect(notifyAdmins(TARGET, state("drifted"), REPORT, ENV)).rejects.toBe(failure);
    expect(mocks.notifyOrgManagers).toHaveBeenCalledTimes(1);
  });

  it("does not post to Slack when the in-app notice fails", async () => {
    reset();
    mocks.notifyOrgManagers.mockRejectedValueOnce(new Error("db down"));
    await expect(notifyAdmins(TARGET, state("drifted"), REPORT, ENV)).rejects.toThrow("db down");
    expect(mocks.notifyOrgSlack).not.toHaveBeenCalled();
  });

  it("reads process.env when no env is passed", async () => {
    reset();
    await notifyAdmins(TARGET, state("drifted"), REPORT);
    expect(mocks.notifyOrgSlack.mock.calls[0]![1]).toBe(process.env);
  });
});
