// repair.ts: put a steering repo back to the baseline (S2, #4560).
//
// A workspace admin selects Repair settings when the steering repo is not
// healthy. Repair writes every baseline setting the host shows differently,
// merges the pull request that puts main back at the published commit when
// the repo diverged, and then reads the health again. The read posts the
// checks and comments, so every open pull request sees the new state.
//
// The revert commit holds the published files on top of main, so once it
// lands the published commit stays the one Oxagen last published, and the
// history read forgives the commits before it (./diverged.ts). Repair records
// no new deployment.
import { HandlerError } from "@oxagen/oxagen";
import { GitHubApiError } from "@oxagen/github";
import * as gh from "@oxagen/github/provision";
import * as gl from "@oxagen/gitlab/provision";
import {
  GITHUB_SETTINGS_BASELINE,
  GITLAB_SETTINGS_BASELINE,
  OXAGEN_STEERING_APP,
} from "@oxagen/oxagen/steering-repo";
import type { RepoHealth } from "@oxagen/oxagen/steering-repo/health";
import {
  STEERING_APP_UNCONFIGURED_MESSAGE,
  steeringAppFromEnv,
} from "../lib/steering-app";
import { logger } from "../logger";
import { steeringGroupToken, steeringInstallationRest } from "../steering_repo.provision";
import { isRevertBranch, revertMessage, revertTitle, REVERT_TRAILER } from "./diverged";
import {
  type HealthOutcome,
  type HealthRow,
  type HealthScope,
  type HealthTrigger,
  isRateLimited,
  type PublishedCommit,
  productionHealthStorage,
  refreshRepoHealth,
} from "./health";
import { loadHealthTarget, type LocatedTarget } from "./health.hosts";

function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** What a merge of the revert pull request did. */
export type RevertMerge =
  | { kind: "merged" }
  /** The pull request is closed or merged already, or is not a revert. */
  | { kind: "gone" }
  /** The host refused the merge, such as when main moved. */
  | { kind: "refused"; message: string };

/** The writes repair makes on one steering repo. */
export interface RepairHost {
  /** The repository as the host names it now, for messages. */
  name(): string;
  /** Write every baseline setting that differs. Returns the settings still different. */
  applyBaseline(): Promise<string[]>;
  /** Merge the pull request that puts main back at `published`. */
  mergeRevert(number: number, published: PublishedCommit): Promise<RevertMerge>;
}

export interface RepairDeps {
  now(): Date;
  locate(scope: HealthScope): Promise<LocatedTarget | null>;
  loadRow(scope: HealthScope): Promise<HealthRow | null>;
  /** The host, or null when this deployment has no Oxagen Steering app settings. */
  host(located: LocatedTarget): Promise<RepairHost | null>;
  /** Read the health again and act on it (`refreshRepoHealth`). */
  refresh(scope: HealthScope, trigger: HealthTrigger): Promise<HealthOutcome | null>;
}

/** A refusal about the repository itself, as opposed to a limit or an outage. */
function refused(err: unknown): boolean {
  if (isRateLimited(err)) return false;
  if (err instanceof gh.SteeringReauthorizeError || err instanceof gl.SteeringGitlabReauthorizeError)
    return true;
  if (err instanceof GitHubApiError || err instanceof gl.GitLabApiError)
    return err.status === 401 || err.status === 403 || err.status === 404;
  return /token mint failed \((403|404)\)/.test(err instanceof Error ? err.message : "");
}

function notReady(): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "steering_repo_not_ready",
    message: "This scope has no steering repo that is ready.",
  });
}

function disconnectedError(name: string, reason: string | null): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "steering_repo_disconnected",
    message:
      reason ??
      `Oxagen can no longer reach the steering repo ${name}. An organization admin must connect it again.`,
  });
}

/**
 * Put the scope's steering repo back to the baseline, merge the revert pull
 * request when main diverged, and read the health again. Returns the health
 * that read found.
 */
export async function repair(
  scope: { orgId: string; workspaceId: string | null },
  input: { actorUserId: string | null },
  deps: RepairDeps = productionRepairDeps(),
): Promise<{ health: RepoHealth }> {
  const located = await deps.locate(scope);
  if (located === null) throw notReady();
  const host = await deps.host(located);
  if (host === null)
    throw new HandlerError({
      code: "conflict",
      reason: "steering_app_unconfigured",
      message: STEERING_APP_UNCONFIGURED_MESSAGE,
    });
  const trigger: HealthTrigger = {
    reason: "repair",
    actor: null,
    at: deps.now().toISOString(),
    settings: [],
    pull_request: null,
  };
  const log = { ...scope, actorUserId: input.actorUserId };

  let row = await deps.loadRow(scope);
  // A disconnected row may be stale. Read again before refusing.
  if (row?.health === "disconnected") {
    const again = await deps.refresh(scope, trigger);
    if (again === null) throw notReady();
    if (again.health === "disconnected")
      throw disconnectedError(host.name(), again.reason);
    row = await deps.loadRow(scope);
  }

  // 1. Settings.
  try {
    const remaining = await host.applyBaseline();
    if (remaining.length > 0)
      logger.warn(
        { ...log, remaining },
        "steering-repo.repair: settings still differ after the repair wrote them",
      );
  } catch (err) {
    if (!refused(err)) throw err;
    const after = await deps.refresh(scope, trigger);
    throw disconnectedError(host.name(), after?.reason ?? null);
  }

  // 2. History.
  if (
    row?.health === "diverged" &&
    row.revertPrNumber !== null &&
    row.publishedSha !== null
  ) {
    const number = row.revertPrNumber;
    const merged = await host.mergeRevert(number, {
      sha: row.publishedSha,
      version: row.publishedVersion,
    });
    if (merged.kind === "refused") {
      // The read opens a new revert pull request when main moved.
      await deps.refresh(scope, trigger);
      throw new HandlerError({
        code: "conflict",
        reason: "steering_revert_refused",
        message: `Oxagen could not merge #${number}, which puts main back at the published version: ${merged.message} Select Repair settings again.`,
      });
    }
    logger.info(
      { ...log, revert: number, merge: merged.kind },
      "steering-repo.repair: handled the revert pull request",
    );
  }

  // 3. Health.
  const outcome = await deps.refresh(scope, trigger);
  if (outcome === null) throw notReady();
  logger.info(
    { ...log, health: outcome.health, previous: outcome.previous },
    "steering-repo.repair: repaired the steering repo",
  );
  return { health: outcome.health };
}

// ── GitHub ───────────────────────────────────────────────────────────────────

interface GithubRepairInput {
  rest: () => Promise<gh.GithubRest>;
  app: gh.SteeringApp;
  repositoryId: number;
  address: gh.RepoAddress;
}

interface GithubPull {
  number: number;
  state: string;
  merged?: boolean;
  head: { ref: string; sha: string };
}

/** The repair host for one GitHub steering repo. */
export function githubRepairHost(input: GithubRepairInput): RepairHost {
  let client: Promise<gh.GithubRest> | null = null;
  const rest = () => (client ??= input.rest());
  let address = input.address;
  const root = () => `/repos/${seg(address.owner)}/${seg(address.name)}`;

  /** Find the repository by id, so a rename does not lose it. */
  async function locate(r: gh.GithubRest): Promise<void> {
    const found = await r.request<{ name: string; owner: { login: string } }>(
      "GET",
      `/repositories/${seg(input.repositoryId)}`,
    );
    if (found.data !== null)
      address = { owner: found.data.owner.login, name: found.data.name };
  }

  return {
    name: () => `${address.owner}/${address.name}`,

    async applyBaseline() {
      const r = await rest();
      await locate(r);
      const { remaining } = await gh.applySettings(
        r,
        address,
        input.app,
        GITHUB_SETTINGS_BASELINE,
      );
      return remaining.map((d) => d.setting);
    },

    async mergeRevert(number, published) {
      const r = await rest();
      const pull = await r.request<GithubPull>(
        "GET",
        `${root()}/pulls/${seg(number)}`,
        undefined,
        [404],
      );
      if (pull.data === null || pull.data.state !== "open" || !isRevertBranch(pull.data.head.ref))
        return { kind: "gone" };
      // 405: not mergeable. 409: the head moved.
      const res = await r.request<{ merged: boolean }>(
        "PUT",
        `${root()}/pulls/${seg(number)}/merge`,
        {
          merge_method: "squash",
          sha: pull.data.head.sha,
          commit_title: revertTitle(published.version),
          commit_message: `${REVERT_TRAILER}: ${published.sha}`,
        },
        [405, 409, 422],
      );
      if (res.data === null || !res.data.merged)
        return { kind: "refused", message: res.message ?? `GitHub answered ${res.status}.` };
      return { kind: "merged" };
    },
  };
}

// ── GitLab ───────────────────────────────────────────────────────────────────

interface GitlabRepairInput {
  rest: () => Promise<gl.GitlabRest | null>;
  projectId: number;
  path: string;
}

interface GitlabMergeRequest {
  iid: number;
  state: string;
  sha: string;
  source_branch: string;
}

/** The repair host for one GitLab steering repo. */
export function gitlabRepairHost(input: GitlabRepairInput): RepairHost {
  let client: Promise<gl.GitlabRest> | null = null;
  const rest = () =>
    (client ??= input.rest().then((r) => {
      if (r === null) throw new gl.SteeringGitlabReauthorizeError(
        `No group access token is stored for ${input.path}.`,
      );
      return r;
    }));
  const root = `/projects/${seg(input.projectId)}`;

  return {
    name: () => input.path,

    async applyBaseline() {
      const r = await rest();
      const user = await gl.getCurrentUser(r);
      const { remaining } = await gl.applyGitlabSettings(
        r,
        input.projectId,
        { symbol: OXAGEN_STEERING_APP, user_id: user.id, username: user.username },
        GITLAB_SETTINGS_BASELINE,
      );
      return remaining.map((d) => d.setting);
    },

    async mergeRevert(iid, published) {
      const r = await rest();
      const request = await r.request<GitlabMergeRequest>(
        "GET",
        `${root}/merge_requests/${seg(iid)}`,
        undefined,
        [404],
      );
      if (
        request.data === null ||
        request.data.state !== "opened" ||
        !isRevertBranch(request.data.source_branch)
      )
        return { kind: "gone" };
      // 405 or 422: not mergeable. 409: the head moved.
      const res = await r.request<{ state: string }>(
        "PUT",
        `${root}/merge_requests/${seg(iid)}/merge`,
        {
          sha: request.data.sha,
          squash: true,
          squash_commit_message: revertMessage(published),
          should_remove_source_branch: true,
        },
        [405, 406, 409, 422],
      );
      if (res.data === null || res.data.state !== "merged")
        return { kind: "refused", message: res.message ?? `GitLab answered ${res.status}.` };
      return { kind: "merged" };
    },
  };
}

// ── Production ───────────────────────────────────────────────────────────────

/** The repair host for a located target, or null without app settings. */
export function repairHostFor(
  located: LocatedTarget,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RepairHost | null {
  const { target, connection } = located;
  if (connection === null) {
    const name = target.repository.full_name;
    const fail = async (): Promise<never> => {
      throw disconnectedError(name, null);
    };
    return { name: () => name, applyBaseline: fail, mergeRevert: fail };
  }
  if (connection.provider === "github") {
    const config = steeringAppFromEnv(env);
    if (config === null) return null;
    return githubRepairHost({
      rest: () => steeringInstallationRest(config, connection.installation_id),
      app: config.app,
      repositoryId: target.repository.id,
      address: { owner: located.owner, name: located.name },
    });
  }
  return gitlabRepairHost({
    rest: async () => {
      const token = await steeringGroupToken(target.scope.orgId, connection.group_id);
      return token === null ? null : gl.createGitlabRest({ token });
    },
    projectId: target.repository.id,
    path: target.repository.full_name,
  });
}

/** The dependencies `repair` runs with. */
export function productionRepairDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RepairDeps {
  return {
    now: () => new Date(),
    locate: loadHealthTarget,
    loadRow: productionHealthStorage.loadRow,
    host: async (located) => repairHostFor(located, env),
    refresh: refreshRepoHealth,
  };
}
