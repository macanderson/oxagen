// health.hosts.ts: the production side of a steering repo health read (S2,
// #4560).
//
// It loads a scope's steering repo from the settings provisioning wrote,
// binds `HealthHost` to GitHub through the Oxagen GitHub App and to GitLab
// through the group access token, and tells the organization's owners and
// admins when the repo changes state. health.ts holds the decisions, and
// ./diverged.ts holds the history reads and the revert pull request.
//
// GitHub finds the repository by its id, so a rename or a transfer inside
// the installation does not lose it. A host that refuses the repository with
// 403 or 404 reads as disconnected. A rate limit, a 5xx, or a bad app key
// throws, so the job retries and records no state it did not read.
import { GitHubApiError, GitHubRateLimitedError } from "@oxagen/github";
import * as gh from "@oxagen/github/provision";
import * as gl from "@oxagen/gitlab/provision";
import { schema, withSystemDb } from "@oxagen/database";
import {
  GITHUB_SETTINGS_BASELINE,
  GITLAB_SETTINGS_BASELINE,
  OXAGEN_STEERING_APP,
  REQUIRED_CHECK_NAME,
} from "@oxagen/oxagen/steering-repo";
import { and, eq, isNull } from "drizzle-orm";
import { steeringAppFromEnv } from "../lib/steering-app";
import { logger } from "../logger";
import {
  readSteeringConnection,
  readSteeringRepoState,
  type SteeringConnection,
  steeringGroupToken,
  steeringInstallationRest,
} from "../steering_repo.provision";
import * as history from "./diverged";
import {
  HEALTH_CHECK_EXTERNAL_ID,
  HEALTH_COMMENT_MARKER,
  type HealthDeps,
  type HealthHost,
  type HealthReport,
  type HealthScope,
  type HealthState,
  type HealthTarget,
  type Observation,
  productionHealthStorage,
  settingDifferences,
} from "./health";

/** Pages of 100 a list reads before it stops. */
const MAX_PAGES = 10;
const PAGE = 100;
/** GitLab cuts a commit status description at 255 characters. */
const GITLAB_DESCRIPTION_LIMIT = 255;
/**
 * Every GitLab status a health read posts starts with this, so a restore can
 * tell the health status from the result the steering checks posted.
 */
export const HEALTH_STATUS_PREFIX = "Steering repo not healthy: ";

function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Read every page of a list, up to `MAX_PAGES`. */
async function allPages<T>(read: (page: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await read(page);
    out.push(...items);
    if (items.length < PAGE) break;
  }
  return out;
}

/** A refusal about the repository itself, as opposed to a limit or an outage. */
function refused(err: unknown): boolean {
  if (err instanceof GitHubRateLimitedError || err instanceof gl.GitLabRateLimitedError)
    return false;
  if (err instanceof gl.SteeringGitlabReauthorizeError) return true;
  return (
    (err instanceof GitHubApiError || err instanceof gl.GitLabApiError) &&
    (err.status === 403 || err.status === 404)
  );
}

/** The status GitHub answered when it refused to mint an installation token. */
function mintStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const match = /token mint failed \((\d{3})\)/.exec(err.message);
  return match ? Number(match[1]) : null;
}

function disconnected(reason: string): Observation {
  return { kind: "disconnected", reason };
}

// ── GitHub ───────────────────────────────────────────────────────────────────

export interface GithubHealthHostInput {
  /** A client holding a fresh installation token. Called once. */
  rest: () => Promise<gh.GithubRest>;
  app: gh.SteeringApp;
  repositoryId: number;
  /** Where provisioning put the repository. A read by id replaces it. */
  address: gh.RepoAddress;
  /** The account the installation belongs to, for the reason text. */
  account: string;
  /** An absolute link to the steering repo in Oxagen, or null. */
  detailsUrl: string | null;
}

interface GithubPull {
  number: number;
  head: { sha: string; ref: string };
}

interface GithubCheckRun {
  id: number;
  status: string;
  conclusion: string | null;
  external_id?: string | null;
  details_url?: string | null;
  completed_at?: string | null;
  output?: { title?: string | null; summary?: string | null } | null;
}

interface GithubComment {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
  performed_via_github_app?: { slug?: string } | null;
}

/** The health host for one GitHub steering repo. */
export function githubHealthHost(input: GithubHealthHostInput): HealthHost {
  let client: Promise<gh.GithubRest> | null = null;
  const rest = () => (client ??= input.rest());
  let address = input.address;
  const root = () => `/repos/${seg(address.owner)}/${seg(address.name)}`;
  const target = async (): Promise<history.GithubHistoryTarget> => ({
    rest: await rest(),
    repo: { ...address, id: input.repositoryId },
    app: input.app,
  });
  const fullName = () => `${address.owner}/${address.name}`;

  /** The app's own comment on a pull request, or null. */
  async function findComment(number: number): Promise<GithubComment | null> {
    const r = await rest();
    const comments = await allPages(async (page) => {
      const res = await r.request<GithubComment[]>(
        "GET",
        `${root()}/issues/${seg(number)}/comments?per_page=${PAGE}&page=${page}`,
      );
      return res.data ?? [];
    });
    return (
      comments.find(
        (c) =>
          (c.body ?? "").includes(HEALTH_COMMENT_MARKER) &&
          (c.performed_via_github_app?.slug === input.app.slug ||
            c.user?.login === `${input.app.slug}[bot]`),
      ) ?? null
    );
  }

  return {
    async observe() {
      let r: gh.GithubRest;
      try {
        r = await rest();
      } catch (err) {
        const status = mintStatus(err);
        if (status === 404)
          return disconnected(
            `The Oxagen GitHub App is no longer installed on ${input.account}.`,
          );
        if (status === 403)
          return disconnected(
            `The Oxagen GitHub App installation on ${input.account} is suspended.`,
          );
        throw err;
      }
      const found = await r.request<{
        name: string;
        full_name: string;
        owner: { login: string };
      }>("GET", `/repositories/${seg(input.repositoryId)}`, undefined, [403, 404]);
      if (found.data === null)
        return disconnected(
          `The repository ${fullName()} was deleted, or the Oxagen GitHub App can no longer see it.`,
        );
      address = { owner: found.data.owner.login, name: found.data.name };
      let actual: gh.ObservedGithubSettings;
      try {
        actual = await gh.readSettings(
          r,
          address,
          input.app,
          Object.keys(GITHUB_SETTINGS_BASELINE.environments),
          Object.keys(GITHUB_SETTINGS_BASELINE.rulesets).length > 0,
        );
      } catch (err) {
        if (!refused(err)) throw err;
        return disconnected(
          `GitHub refused to show the Oxagen GitHub App the settings of ${found.data.full_name}.`,
        );
      }
      return {
        kind: "connected",
        repository: found.data.full_name,
        differences: settingDifferences({
          provider: "github",
          baseline: GITHUB_SETTINGS_BASELINE,
          actual,
        }),
      };
    },

    published: async () => history.githubPublished(await target()),
    diverged: async (published) => history.githubDiverged(await target(), published),
    openRevert: async (published, divergence, previous) =>
      history.githubOpenRevert(await target(), published, divergence, previous),
    closeRevert: async (number) => history.githubCloseRevert(await target(), number),
    isRevert: (pr) => history.isRevertBranch(pr.head_ref),

    async openPullRequests() {
      const r = await rest();
      const pulls = await allPages(async (page) => {
        const res = await r.request<GithubPull[]>(
          "GET",
          `${root()}/pulls?state=open&per_page=${PAGE}&page=${page}`,
        );
        return res.data ?? [];
      });
      return pulls.map((p) => ({
        number: p.number,
        head_sha: p.head.sha,
        head_ref: p.head.ref,
      }));
    },

    async failCheck(pr, report) {
      await (await rest()).request("POST", `${root()}/check-runs`, {
        name: REQUIRED_CHECK_NAME,
        head_sha: pr.head_sha,
        status: "completed",
        conclusion: "failure",
        external_id: HEALTH_CHECK_EXTERNAL_ID,
        ...(input.detailsUrl !== null ? { details_url: input.detailsUrl } : {}),
        output: { title: report.title, summary: report.summary },
      });
    },

    async restoreCheck(pr) {
      const r = await rest();
      const res = await r.request<{ check_runs: GithubCheckRun[] }>(
        "GET",
        `${root()}/commits/${seg(pr.head_sha)}/check-runs?check_name=${seg(REQUIRED_CHECK_NAME)}&app_id=${seg(input.app.id)}&filter=all&per_page=${PAGE}`,
      );
      const last = (res.data?.check_runs ?? [])
        .filter(
          (run) =>
            run.external_id !== HEALTH_CHECK_EXTERNAL_ID &&
            run.status === "completed" &&
            run.conclusion !== null,
        )
        .sort((a, b) => b.id - a.id)[0];
      // The steering checks never finished on this head. They post their
      // result when they do, and that result is the one GitHub reads.
      if (last === undefined) return;
      await r.request("POST", `${root()}/check-runs`, {
        name: REQUIRED_CHECK_NAME,
        head_sha: pr.head_sha,
        status: "completed",
        conclusion: last.conclusion,
        ...(last.details_url ? { details_url: last.details_url } : {}),
        output: {
          title: last.output?.title ?? "Steering checks",
          summary: last.output?.summary ?? "",
        },
      });
    },

    async upsertComment(pr, body, onlyIfExists) {
      const found = await findComment(pr.number);
      const r = await rest();
      if (found !== null) {
        if (found.body === body) return;
        await r.request("PATCH", `${root()}/issues/comments/${seg(found.id)}`, { body });
        return;
      }
      if (onlyIfExists) return;
      await r.request("POST", `${root()}/issues/${seg(pr.number)}/comments`, { body });
    },
  };
}

// ── GitLab ───────────────────────────────────────────────────────────────────

export interface GitlabHealthHostInput {
  /** A client holding the group's token, or null when none is stored. Called once. */
  rest: () => Promise<gl.GitlabRest | null>;
  projectId: number;
  /** The group path, for the reason text. */
  group: string;
  /** Where provisioning put the project. A read by id replaces it. */
  path: string;
  /** An absolute link to the steering repo in Oxagen, or null. */
  detailsUrl: string | null;
}

interface GitlabMergeRequest {
  iid: number;
  sha: string;
  source_branch: string;
}

interface GitlabStatus {
  id: number;
  status: string;
  description?: string | null;
  target_url?: string | null;
}

interface GitlabNote {
  id: number;
  body?: string | null;
  author?: { id?: number } | null;
}

/** The states a commit status can be posted with. */
const GITLAB_POSTABLE = new Set([
  "pending",
  "running",
  "success",
  "failed",
  "canceled",
  "skipped",
]);

function gitlabDescription(text: string): string {
  return text.length > GITLAB_DESCRIPTION_LIMIT
    ? `${text.slice(0, GITLAB_DESCRIPTION_LIMIT - 3)}...`
    : text;
}

/** The health host for one GitLab steering repo. */
export function gitlabHealthHost(input: GitlabHealthHostInput): HealthHost {
  let client: Promise<gl.GitlabRest | null> | null = null;
  const maybeRest = () => (client ??= input.rest());
  const rest = async (): Promise<gl.GitlabRest> => {
    const r = await maybeRest();
    if (r === null)
      throw new Error(`No group access token is stored for ${input.group}.`);
    return r;
  };
  let bot: Promise<gl.SteeringBot> | null = null;
  const steeringBot = () =>
    (bot ??= rest().then(async (r) => {
      const user = await gl.getCurrentUser(r);
      return { symbol: OXAGEN_STEERING_APP, user_id: user.id, username: user.username };
    }));
  const root = `/projects/${seg(input.projectId)}`;
  const target = async (): Promise<history.GitlabHistoryTarget> => ({
    rest: await rest(),
    projectId: input.projectId,
    bot: await steeringBot(),
  });
  const reconnect = `An organization admin must connect the group ${input.group} again.`;

  return {
    async observe() {
      const r = await maybeRest();
      if (r === null)
        return disconnected(
          `No group access token is stored for ${input.group}. ${reconnect}`,
        );
      try {
        const me = await steeringBot();
        const project = await r.request<{ path_with_namespace: string }>(
          "GET",
          root,
          undefined,
          [403, 404],
        );
        if (project.data === null)
          return disconnected(
            `The project ${input.path} was deleted, or the group access token can no longer see it.`,
          );
        const actual = await gl.readGitlabSettings(r, input.projectId, me);
        return {
          kind: "connected",
          repository: project.data.path_with_namespace,
          differences: settingDifferences({
            provider: "gitlab",
            baseline: GITLAB_SETTINGS_BASELINE,
            actual,
            bot: me,
          }),
        };
      } catch (err) {
        if (err instanceof gl.SteeringGitlabReauthorizeError)
          return disconnected(
            `GitLab refused the group access token for ${input.group}. ${reconnect}`,
          );
        if (refused(err))
          return disconnected(
            `GitLab refused to show the settings of ${input.path} to the group access token.`,
          );
        throw err;
      }
    },

    published: async () => history.gitlabPublished(await target()),
    diverged: async (published) => history.gitlabDiverged(await target(), published),
    openRevert: async (published, divergence, previous) =>
      history.gitlabOpenRevert(await target(), published, divergence, previous),
    closeRevert: async (iid) => history.gitlabCloseRevert(await target(), iid),
    isRevert: (pr) => history.isRevertBranch(pr.head_ref),

    async openPullRequests() {
      const r = await rest();
      const requests = await allPages(async (page) => {
        const res = await r.request<GitlabMergeRequest[]>(
          "GET",
          `${root}/merge_requests?state=opened&per_page=${PAGE}&page=${page}`,
        );
        return res.data ?? [];
      });
      return requests.map((m) => ({
        number: m.iid,
        head_sha: m.sha,
        head_ref: m.source_branch,
      }));
    },

    async failCheck(pr, report) {
      // 400: the head already carries a failed status under this name.
      await (await rest()).request(
        "POST",
        `${root}/statuses/${seg(pr.head_sha)}`,
        {
          state: "failed",
          name: REQUIRED_CHECK_NAME,
          description: gitlabDescription(`${HEALTH_STATUS_PREFIX}${report.title}`),
          ...(input.detailsUrl !== null ? { target_url: input.detailsUrl } : {}),
        },
        [400],
      );
    },

    async restoreCheck(pr) {
      const r = await rest();
      const res = await r.request<GitlabStatus[]>(
        "GET",
        `${root}/repository/commits/${seg(pr.head_sha)}/statuses?name=${seg(REQUIRED_CHECK_NAME)}&all=true&per_page=${PAGE}`,
      );
      const last = (res.data ?? [])
        .filter(
          (s) =>
            !(s.description ?? "").startsWith(HEALTH_STATUS_PREFIX) &&
            GITLAB_POSTABLE.has(s.status),
        )
        .sort((a, b) => b.id - a.id)[0];
      // The steering checks never posted on this head. They post their
      // result when they do, and that result is the one GitLab reads.
      if (last === undefined) return;
      await r.request(
        "POST",
        `${root}/statuses/${seg(pr.head_sha)}`,
        {
          state: last.status,
          name: REQUIRED_CHECK_NAME,
          ...(last.description ? { description: last.description } : {}),
          ...(last.target_url ? { target_url: last.target_url } : {}),
        },
        [400],
      );
    },

    async upsertComment(pr, body, onlyIfExists) {
      const r = await rest();
      const me = await steeringBot();
      const notes = await allPages(async (page) => {
        const res = await r.request<GitlabNote[]>(
          "GET",
          `${root}/merge_requests/${seg(pr.number)}/notes?sort=asc&order_by=created_at&per_page=${PAGE}&page=${page}`,
        );
        return res.data ?? [];
      });
      const found = notes.find(
        (n) =>
          (n.body ?? "").includes(HEALTH_COMMENT_MARKER) && n.author?.id === me.user_id,
      );
      if (found !== undefined) {
        if (found.body === body) return;
        await r.request(
          "PUT",
          `${root}/merge_requests/${seg(pr.number)}/notes/${seg(found.id)}`,
          { body },
        );
        return;
      }
      if (onlyIfExists) return;
      await r.request("POST", `${root}/merge_requests/${seg(pr.number)}/notes`, { body });
    },
  };
}

// ── Without a connection ─────────────────────────────────────────────────────

/**
 * The host for a ready steering repo whose organization no longer names a
 * steering connection. Every read says so, and nothing can be posted.
 */
export function unconnectedHealthHost(reason: string): HealthHost {
  const refuse = async (): Promise<never> => {
    throw new Error(reason);
  };
  return {
    observe: async () => disconnected(reason),
    published: refuse,
    diverged: refuse,
    openRevert: refuse,
    closeRevert: refuse,
    isRevert: () => false,
    openPullRequests: refuse,
    failCheck: refuse,
    restoreCheck: refuse,
    upsertComment: refuse,
  };
}

// ── Targets ──────────────────────────────────────────────────────────────────

/** What a host needs about a target beyond what health.ts reads. */
export interface LocatedTarget {
  target: HealthTarget;
  connection: SteeringConnection | null;
  owner: string;
  name: string;
}

/** An absolute link for a check, from the app's public URL, or null. */
function absolute(path: string, env: Readonly<Record<string, string | undefined>>): string | null {
  const origin = env["APP_URL"] ?? env["NEXT_PUBLIC_APP_URL"];
  if (!origin) return null;
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/**
 * The scope's steering repo, or null when it has none that is ready. The
 * organization's settings name the connection, and the workspace's (or the
 * organization's) settings name the repository.
 */
export async function loadHealthTarget(
  scope: HealthScope,
): Promise<LocatedTarget | null> {
  const o = schema.organizations;
  const w = schema.workspaces;
  // tenancy: filtered by the scope's orgId. The health event carries it from
  // a webhook matched to this organization's own steering repo, or from the
  // sweep's list of ready steering repos.
  const [org] = await withSystemDb((tx) =>
    tx.select({ slug: o.slug, settings: o.settings }).from(o).where(eq(o.id, scope.orgId)).limit(1),
  );
  if (!org) return null;
  let settings: unknown = org.settings;
  let deepLink = `/${org.slug}`;
  if (scope.workspaceId !== null) {
    // tenancy: filtered by workspaceId and orgId together, both from the
    // health event.
    const [workspace] = await withSystemDb((tx) =>
      tx
        .select({ slug: w.slug, settings: w.settings })
        .from(w)
        .where(
          and(eq(w.id, scope.workspaceId as string), eq(w.orgId, scope.orgId), isNull(w.archivedAt)),
        )
        .limit(1),
    );
    if (!workspace) return null;
    settings = workspace.settings;
    deepLink = `/${org.slug}/${workspace.slug}/repositories`;
  }
  const state = readSteeringRepoState(settings);
  if (
    state === null ||
    state.status !== "ready" ||
    state.provider === null ||
    state.repository === null
  )
    return null;
  const connection = readSteeringConnection(org.settings);
  return {
    target: {
      scope,
      provider: state.provider,
      repository: { id: state.repository.id, full_name: state.repository.full_name },
      deepLink,
    },
    connection: connection !== null && connection.provider === state.provider ? connection : null,
    owner: state.repository.owner,
    name: state.repository.name,
  };
}

/**
 * The host for a located target, or null when this deployment has no Oxagen
 * Steering app settings for a GitHub repo.
 */
export function healthHostFor(
  located: LocatedTarget,
  env: Readonly<Record<string, string | undefined>> = process.env,
): HealthHost | null {
  const { target, connection } = located;
  const detailsUrl = absolute(target.deepLink, env);
  if (connection === null)
    return unconnectedHealthHost(
      `The organization no longer has a ${target.provider === "github" ? "GitHub" : "GitLab"} steering connection. An organization admin must connect it again.`,
    );
  if (connection.provider === "github") {
    const config = steeringAppFromEnv(env);
    if (config === null) {
      logger.warn(
        { orgId: target.scope.orgId, workspaceId: target.scope.workspaceId },
        "steering-repo.health: the Oxagen GitHub App is not configured, so this deployment cannot read the steering repo",
      );
      return null;
    }
    return githubHealthHost({
      rest: () => steeringInstallationRest(config, connection.installation_id),
      app: config.app,
      repositoryId: target.repository.id,
      address: { owner: located.owner, name: located.name },
      account: connection.account_login,
      detailsUrl,
    });
  }
  return gitlabHealthHost({
    rest: async () => {
      const token = await steeringGroupToken(target.scope.orgId, connection.group_id);
      return token === null ? null : gl.createGitlabRest({ token });
    },
    projectId: target.repository.id,
    group: connection.group_path,
    path: target.repository.full_name,
    detailsUrl,
  });
}

// ── Notifications ────────────────────────────────────────────────────────────

/** The notification title for a state, as one sentence. */
export function healthNotificationTitle(state: HealthState, repository: string): string {
  switch (state.health) {
    case "healthy":
      return `The steering repo ${repository} is healthy again`;
    case "drifted":
      return `Settings changed on the steering repo ${repository}`;
    case "disconnected":
      return `Oxagen lost access to the steering repo ${repository}`;
    case "diverged":
      return `main on the steering repo ${repository} holds a commit Oxagen did not merge`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The email body: the title, then each line of the report. */
export function healthEmailHtml(title: string, summary: string): string {
  const lines = summary
    .split("\n")
    .map((line) => escapeHtml(line))
    .join("<br>");
  return `<p><strong>${escapeHtml(title)}</strong></p><p>${lines}</p>`;
}

/**
 * Tell the organization's Owners and Admins that the steering repo changed
 * state: an in-app notice and an email to each, then one message in the
 * Slack channel the organization picked, when it has one. A throw from
 * either leaves the notified state as it was, so the next health read sends
 * the notice again.
 */
export async function notifyAdmins(
  target: HealthTarget,
  state: HealthState,
  report: HealthReport,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const { notifyOrgManagers, notifyOrgSlack } = await import("@oxagen/notifications");
  const title = healthNotificationTitle(state, target.repository.full_name);
  const workspace =
    target.scope.workspaceId !== null ? { workspaceId: target.scope.workspaceId } : {};
  await notifyOrgManagers({
    orgId: target.scope.orgId,
    ...workspace,
    kind: "security",
    title,
    body: report.summary,
    deepLink: target.deepLink,
    emailHtml: healthEmailHtml(title, report.summary),
  });
  await notifyOrgSlack(
    {
      orgId: target.scope.orgId,
      ...workspace,
      kind: "security",
      title,
      body: report.summary,
      deepLink: target.deepLink,
    },
    env,
  );
}

// ── Production dependencies ──────────────────────────────────────────────────

/** The dependencies `refreshRepoHealth` runs with. */
export function productionHealthDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HealthDeps {
  const located = new WeakMap<HealthTarget, LocatedTarget>();
  return {
    now: () => new Date(),
    async loadTarget(scope) {
      const found = await loadHealthTarget(scope);
      if (found === null) return null;
      located.set(found.target, found);
      return found.target;
    },
    ...productionHealthStorage,
    async host(target) {
      const found = located.get(target);
      return found === undefined ? null : healthHostFor(found, env);
    },
    notify: (target, state, report) => notifyAdmins(target, state, report, env),
  };
}

