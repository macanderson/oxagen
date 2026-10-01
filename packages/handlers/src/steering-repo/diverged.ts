// diverged.ts: whether main holds commits Oxagen did not merge, and the pull
// request that puts main back at the published commit.
//
// GitHub provenance comes from the host's merged pull request records. Commit
// messages and authors cannot prove who merged a change. Equal tree hashes
// prove restoration to published files. GitLab retains its protected-branch
// trailer checks.
//
// This module imports only types from ./health, so health.ts reaches it
// through ./health.hosts.ts without a runtime cycle. Every host error the
// calls do not name propagates, because health.ts catches and logs it.
import type {
  GithubRest,
  RepoAddress,
  SteeringApp,
} from "@oxagen/github/provision";
import type { GitlabRest, SteeringBot } from "@oxagen/gitlab/provision";
import {
  REQUIRED_CHECK_NAME,
  STEERING_DEFAULT_BRANCH,
  STEERING_ENVIRONMENT,
} from "@oxagen/oxagen/steering-repo/names";
import type { Divergence, PublishedCommit } from "./health";

// ── Names ────────────────────────────────────────────────────────────────────

/** The trailer the merge queue writes on every squash merge. */
export const VERSION_TRAILER = "Oxagen-Version";
/** The trailer a revert commit carries, naming the published commit. */
export const REVERT_TRAILER = "Oxagen-Revert-To";
/** Every revert branch starts with this. */
export const REVERT_BRANCH_PREFIX = "steering/revert-to-";

/**
 * The message of the commit that seeds main. Copied from
 * `FIRST_COMMIT_MESSAGE` in ../steering_repo.provision.ts, which imports the
 * database. Provisioning records that commit as version 1.
 */
const FIRST_COMMIT_MESSAGE = "Seed the steering repo";
const FIRST_VERSION = 1;

/** The external id of the check run on a revert commit, so a rerun finds it. */
const REVERT_CHECK_EXTERNAL_ID = "oxagen-steering-revert";

const SHORT_SHA = 7;
/** Commits one GitHub compare page holds. More than this reads as truncated. */
const COMPARE_PAGE = 100;
const GITHUB_DEPLOYMENT_PAGE = 30;
const GITLAB_DEPLOYMENT_PAGE = 20;
/** Revert commits a GitLab read compares with the published content, newest first. */
const RESTORE_PROBES = 20;

const VERSION_LINE = new RegExp(
  `^${VERSION_TRAILER}:[ \\t]*(\\d+)[ \\t]*\\r?$`,
  "m",
);
const REVERT_LINE = new RegExp(
  `^${REVERT_TRAILER}:[ \\t]*([0-9a-f]{40})[ \\t]*\\r?$`,
  "m",
);
/**
 * The description `recordPublishDeployment` (merge-queue.ts) gives a publish:
 * `Steering version N from #M`. Those deployments carry no payload.
 */
const DEPLOYMENT_DESCRIPTION = /^Steering version (\d+)\b/;

function short(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

function parseVersion(digits: string | undefined): number | null {
  if (digits === undefined) return null;
  const version = Number(digits);
  return Number.isSafeInteger(version) ? version : null;
}

/** `steering/revert-to-<published 7>-<main 7>` */
export function revertBranch(publishedSha: string, mainSha: string): string {
  return `${REVERT_BRANCH_PREFIX}${short(publishedSha)}-${short(mainSha)}`;
}

/** Whether `ref` names a revert branch. Takes `refs/heads/...` too. */
export function isRevertBranch(ref: string): boolean {
  const name = ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref;
  return (
    name.startsWith(REVERT_BRANCH_PREFIX) &&
    name.length > REVERT_BRANCH_PREFIX.length
  );
}

/** The version an `Oxagen-Version: N` trailer names, or null. */
export function versionTrailer(message: string): number | null {
  return parseVersion(VERSION_LINE.exec(message)?.[1]);
}

/** The published commit an `Oxagen-Revert-To: <sha>` trailer names, or null. */
export function revertTrailer(message: string): string | null {
  return REVERT_LINE.exec(message)?.[1] ?? null;
}

/** The title of the revert pull request and of its commit. */
export function revertTitle(version: number | null): string {
  return version === null
    ? "Revert main to the last published version"
    : `Revert main to published version ${version}`;
}

/** The revert commit's message: the title, a blank line, and the trailer. */
export function revertMessage(published: PublishedCommit): string {
  return `${revertTitle(published.version)}\n\n${REVERT_TRAILER}: ${published.sha}`;
}

// ── Judging ──────────────────────────────────────────────────────────────────

/** One commit on main after the published one. */
export interface HistoryCommit {
  sha: string;
  parents: readonly string[];
  message: string;
  /** Host-authenticated merge provenance. Undefined keeps the GitLab trailer checks. */
  authenticated?: boolean;
}

/** What a host says about main since the published commit. */
export interface HistoryRange {
  status: "identical" | "ahead" | "behind" | "diverged";
  /** The commits after the published one, oldest first. */
  commits: readonly HistoryCommit[];
  /** True when the host holds more commits than `commits` lists. */
  truncated: boolean;
  main_sha: string;
  /**
   * The index of the last commit whose files equal the published commit's,
   * or -1. Commits up to it are forgiven, because main came back.
   */
  restored_at: number;
}

/** Prefer host-authenticated provenance. GitLab uses its protected history trailers. */
function oxagenMade(published: PublishedCommit, commit: HistoryCommit): boolean {
  if (commit.authenticated !== undefined) return commit.authenticated;
  if (commit.parents.length !== 1) return false;
  if (revertTrailer(commit.message) === published.sha) return true;
  const version = versionTrailer(commit.message);
  if (version === null) return false;
  return published.version === null || version > published.version;
}

/**
 * The commits Oxagen made in `commits`: its squash merges, its reverts, and
 * the merge commits GitLab adds over them. GitLab's default merge method
 * lands a squash as a merge commit whose second parent is the squash, so a
 * merge commit counts as Oxagen's when the commit it merges does.
 */
function oxagenCommits(
  published: PublishedCommit,
  commits: readonly HistoryCommit[],
): Set<string> {
  const made = new Set<string>();
  for (const commit of commits)
    if (oxagenMade(published, commit)) made.add(commit.sha);
  for (const commit of commits) {
    const merged = commit.parents[1];
    if (
      commit.authenticated === undefined &&
      commit.parents.length === 2 &&
      merged !== undefined &&
      made.has(merged)
    )
      made.add(commit.sha);
  }
  return made;
}

/** Whether main holds commits Oxagen did not merge, judged from `range`. */
export function judgeHistory(
  published: PublishedCommit,
  range: HistoryRange,
): Divergence | null {
  if (range.status === "identical") return null;
  const main_sha = range.main_sha;
  const p7 = short(published.sha);
  if (range.status === "behind" || range.status === "diverged")
    return {
      reason: `main no longer contains the published commit ${p7}`,
      main_sha,
    };
  if (range.truncated)
    return {
      reason: `main holds more commits since the published commit ${p7} than Oxagen can read`,
      main_sha,
    };
  const made = oxagenCommits(published, range.commits);
  const foreign = range.commits
    .slice(range.restored_at + 1)
    .filter((commit) => !made.has(commit.sha));
  const first = foreign[0];
  if (first === undefined) return null;
  const reason =
    foreign.length === 1
      ? `main holds 1 commit Oxagen did not merge: ${short(first.sha)}`
      : `main holds ${foreign.length} commits Oxagen did not merge, starting with ${short(first.sha)}`;
  return { reason, main_sha };
}

// ── Shared text ──────────────────────────────────────────────────────────────

function need<T>(data: T | null, what: string): T {
  if (data === null) throw new Error(`The ${what} came back empty.`);
  return data;
}

/** Two or three sentences for the revert pull request or merge request. */
function revertBody(
  published: PublishedCommit,
  divergence: Divergence,
  noun: "pull request" | "merge request",
): string {
  const reason =
    divergence.reason.charAt(0).toUpperCase() + divergence.reason.slice(1);
  const target =
    published.version === null
      ? "the last published version"
      : `published version ${published.version}`;
  return [
    `${reason}.`,
    `This ${noun} puts main back at ${target}, and a workspace admin merges it with Repair settings.`,
    "Whoever changed main can propose the change again through a steering PR.",
  ].join(" ");
}

function revertSummary(published: PublishedCommit): string {
  return `This commit holds the files of the published commit ${short(published.sha)}, so it needs no steering checks.`;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

export interface GithubHistoryTarget {
  rest: GithubRest;
  repo: RepoAddress & { id?: number };
  app: SteeringApp;
  defaultBranch?: string;
}

interface GithubDeployment {
  sha: string;
  description?: string | null;
  payload?: unknown;
  performed_via_github_app?: { id?: number; slug?: string } | null;
}

interface GithubCompare {
  status: HistoryRange["status"];
  total_commits: number;
  base_commit: { commit: { tree: { sha: string } } };
  commits: {
    sha: string;
    parents: { sha: string }[];
    commit: { message: string; tree: { sha: string } };
  }[];
}

interface GithubGitCommit {
  sha: string;
  tree: { sha: string };
  parents: { sha: string }[];
}

interface GithubPull {
  number: number;
  state: string;
  head: { ref: string };
  base: { ref: string };
}

interface GithubCheckRuns {
  check_runs: { external_id?: string | null; conclusion?: string | null }[];
}

function githubRoot(t: GithubHistoryTarget): string {
  return `/repos/${seg(t.repo.owner)}/${seg(t.repo.name)}`;
}

/** A branch name in a git ref path keeps its slashes. */
function refPath(branch: string): string {
  return branch.split("/").map(seg).join("/");
}

/**
 * The version a deployment names. Provisioning writes `payload.version`,
 * which GitHub returns as an object or as a JSON string. The merge queue
 * writes no payload and names the version in the description.
 */
function deploymentVersion(deployment: GithubDeployment): number | null {
  let payload = deployment.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      payload = null;
    }
  }
  if (payload !== null && typeof payload === "object") {
    const version = (payload as { version?: unknown }).version;
    if (typeof version === "number" && Number.isSafeInteger(version))
      return version;
  }
  return parseVersion(
    DEPLOYMENT_DESCRIPTION.exec(deployment.description ?? "")?.[1],
  );
}

/** The newest deployment the steering app recorded, or null. */
export async function githubPublished(
  t: GithubHistoryTarget,
): Promise<PublishedCommit | null> {
  const res = await t.rest.request<GithubDeployment[]>(
    "GET",
    `${githubRoot(t)}/deployments?environment=${seg(STEERING_ENVIRONMENT)}&per_page=${GITHUB_DEPLOYMENT_PAGE}`,
  );
  const hit = (res.data ?? []).find((d) => {
    const app = d.performed_via_github_app;
    return app?.slug === t.app.slug && (app.id === undefined || app.id === t.app.id);
  });
  if (hit === undefined) return null;
  return { sha: hit.sha, version: deploymentVersion(hit) };
}

async function githubMainSha(t: GithubHistoryTarget): Promise<string> {
  const res = await t.rest.request<{ commit: { sha: string } }>(
    "GET",
    `${githubRoot(t)}/branches/${seg(t.defaultBranch ?? STEERING_DEFAULT_BRANCH)}`,
  );
  return need(res.data, "GitHub branch").commit.sha;
}

async function githubCommit(
  t: GithubHistoryTarget,
  sha: string,
): Promise<GithubGitCommit> {
  const res = await t.rest.request<GithubGitCommit>(
    "GET",
    `${githubRoot(t)}/git/commits/${seg(sha)}`,
  );
  return need(res.data, "GitHub commit");
}

interface GithubMergedPull {
  merged?: boolean;
  merge_commit_sha?: string | null;
  base?: { ref?: string; repo?: { id?: number; full_name?: string } | null };
  merged_by?: { type?: string; login?: string } | null;
}

/** Authenticate the merge against the full pull request returned by GitHub. */
async function githubAuthenticatedMerge(
  t: GithubHistoryTarget,
  sha: string,
): Promise<boolean> {
  const root = githubRoot(t);
  const listed = await t.rest.request<{ number: number }[]>(
    "GET",
    `${root}/commits/${seg(sha)}/pulls?per_page=100`,
  );
  for (const summary of need(listed.data, "GitHub commit pull requests")) {
    const response = await t.rest.request<GithubMergedPull>(
      "GET",
      `${root}/pulls/${seg(summary.number)}`,
    );
    const pull = need(response.data, "GitHub pull request");
    const repo = pull.base?.repo;
    const sameRepo =
      t.repo.id !== undefined
        ? repo?.id === t.repo.id
        : repo?.full_name?.toLowerCase() ===
          `${t.repo.owner}/${t.repo.name}`.toLowerCase();
    if (
      pull.merged === true &&
      pull.merge_commit_sha === sha &&
      pull.base?.ref === (t.defaultBranch ?? STEERING_DEFAULT_BRANCH) &&
      sameRepo &&
      pull.merged_by?.type === "Bot" &&
      pull.merged_by.login === `${t.app.slug}[bot]`
    )
      return true;
  }
  return false;
}

/** Judge the exact candidate, or the default branch, since `published`. */
export async function githubDiverged(
  t: GithubHistoryTarget,
  published: PublishedCommit,
  candidateSha?: string,
): Promise<Divergence | null> {
  if (candidateSha !== undefined && !/^[0-9a-f]{40}$/.test(candidateSha))
    throw new Error("Steering provenance requires a full commit SHA.");
  const candidate = candidateSha ?? t.defaultBranch ?? STEERING_DEFAULT_BRANCH;
  const res = await t.rest.request<GithubCompare>(
    "GET",
    `${githubRoot(t)}/compare/${seg(published.sha)}...${seg(candidate)}?per_page=${COMPARE_PAGE}`,
    undefined,
    [404],
  );
  // GitHub answers 404 when the published commit is gone from the repository.
  if (res.status === 404)
    return judgeHistory(published, {
      status: "diverged",
      commits: [],
      truncated: false,
      main_sha: candidateSha ?? (await githubMainSha(t)),
      restored_at: -1,
    });
  const compare = need(res.data, "GitHub compare");
  const baseTree = compare.base_commit.commit.tree.sha;
  let restored_at = -1;
  compare.commits.forEach((commit, index) => {
    if (commit.commit.tree.sha === baseTree) restored_at = index;
  });
  const truncated = compare.commits.length < compare.total_commits;
  const last = compare.commits.at(-1);
  // A rewritten main whose newest commit holds the published files again
  // needs no revert. A revert would add a commit that changes nothing.
  if (
    compare.status === "diverged" &&
    !truncated &&
    last !== undefined &&
    restored_at === compare.commits.length - 1
  )
    return null;
  const main_sha =
    candidateSha ??
    (compare.status === "identical"
      ? published.sha
      : !truncated && last !== undefined
        ? last.sha
        : await githubMainSha(t));
  const commits: HistoryCommit[] = [];
  for (const [index, commit] of compare.commits.entries()) {
    commits.push({
      sha: commit.sha,
      parents: commit.parents.map((parent) => parent.sha),
      message: commit.commit.message,
      // A restored tree discards earlier changes. Every later commit needs proof.
      authenticated:
        compare.status === "ahead" && !truncated && index > restored_at
          ? await githubAuthenticatedMerge(t, commit.sha)
          : false,
    });
  }
  return judgeHistory(published, {
    status: compare.status,
    commits,
    truncated,
    main_sha,
    restored_at,
  });
}

/** Refuse an exact commit unless it descends safely from an app deployment. */
export async function assertGithubSteeringCommit(
  t: GithubHistoryTarget,
  commit: string,
): Promise<void> {
  const published = await githubPublished(t);
  if (published === null)
    throw new Error(
      "No authenticated Oxagen steering deployment anchors this repository.",
    );
  const divergence = await githubDiverged(t, published, commit);
  if (divergence !== null)
    throw new Error(
      `Oxagen cannot accept steering commit ${short(commit)}: ${divergence.reason}.`,
    );
}

/**
 * Find the open pull request from `branch` into main. Close every open pull
 * request from `branch` into another branch, because Repair refuses to merge
 * one and Oxagen opens a new one into main in its place.
 */
async function githubFindPull(
  t: GithubHistoryTarget,
  branch: string,
): Promise<number | null> {
  const root = githubRoot(t);
  const res = await t.rest.request<GithubPull[]>(
    "GET",
    `${root}/pulls?state=open&head=${seg(`${t.repo.owner}:${branch}`)}`,
  );
  let found: number | null = null;
  for (const pull of res.data ?? []) {
    if (pull.head.ref !== branch) continue;
    if (pull.base.ref === STEERING_DEFAULT_BRANCH) {
      if (found === null) found = pull.number;
      continue;
    }
    // Close it first, so the branch never has two open pull requests.
    await t.rest.request("PATCH", `${root}/pulls/${seg(pull.number)}`, {
      state: "closed",
    });
  }
  return found;
}

async function githubRevertPull(
  t: GithubHistoryTarget,
  branch: string,
  published: PublishedCommit,
  divergence: Divergence,
  previous: number | null,
): Promise<number> {
  const root = githubRoot(t);
  if (previous !== null) {
    const prev = await t.rest.request<GithubPull>(
      "GET",
      `${root}/pulls/${seg(previous)}`,
      undefined,
      [404],
    );
    if (
      prev.data?.state === "open" &&
      prev.data.head.ref === branch &&
      prev.data.base.ref === STEERING_DEFAULT_BRANCH
    )
      return previous;
  }
  const found = await githubFindPull(t, branch);
  if (found !== null) return found;
  const made = await t.rest.request<GithubPull>(
    "POST",
    `${root}/pulls`,
    {
      title: revertTitle(published.version),
      head: branch,
      base: STEERING_DEFAULT_BRANCH,
      body: revertBody(published, divergence, "pull request"),
    },
    [422],
  );
  if (made.status !== 422) return need(made.data, "GitHub pull request").number;
  // GitHub answers 422 when a pull request for the branch opened since the list.
  const again = await githubFindPull(t, branch);
  if (again === null)
    throw new Error(
      `GitHub refused the revert pull request for ${branch}: ${made.message ?? "status 422"}`,
    );
  return again;
}

async function githubHasRevertCheck(
  t: GithubHistoryTarget,
  sha: string,
): Promise<boolean> {
  const res = await t.rest.request<GithubCheckRuns>(
    "GET",
    `${githubRoot(t)}/commits/${seg(sha)}/check-runs?check_name=${seg(REQUIRED_CHECK_NAME)}&app_id=${seg(t.app.id)}`,
  );
  return (res.data?.check_runs ?? []).some(
    (run) =>
      run.external_id === REVERT_CHECK_EXTERNAL_ID && run.conclusion === "success",
  );
}

/**
 * Open, or find, the pull request that puts main back at `published`, and
 * close `previous` when it is a different one. Returns its number. A rerun
 * against an unchanged main writes nothing. Oxagen closes a revert pull
 * request someone retargeted away from main and opens a new one into main.
 */
export async function githubOpenRevert(
  t: GithubHistoryTarget,
  published: PublishedCommit,
  divergence: Divergence,
  previous: number | null,
): Promise<number> {
  const root = githubRoot(t);
  const main = divergence.main_sha;
  const branch = revertBranch(published.sha, main);
  const tree = (await githubCommit(t, published.sha)).tree.sha;

  // Reuse the branch when its head holds the published files on top of main.
  let head: string | null = null;
  const ref = await t.rest.request<{ object: { sha: string } }>(
    "GET",
    `${root}/git/ref/heads/${refPath(branch)}`,
    undefined,
    [404],
  );
  if (ref.data !== null) {
    const tip = await githubCommit(t, ref.data.object.sha);
    if (
      tip.tree.sha === tree &&
      tip.parents.length === 1 &&
      tip.parents[0]?.sha === main
    )
      head = tip.sha;
  }
  const reused = head !== null;
  if (head === null) {
    const made = await t.rest.request<{ sha: string }>(
      "POST",
      `${root}/git/commits`,
      { message: revertMessage(published), tree, parents: [main] },
    );
    head = need(made.data, "GitHub commit").sha;
    const created = await t.rest.request(
      "POST",
      `${root}/git/refs`,
      { ref: `refs/heads/${branch}`, sha: head },
      [422],
    );
    // 422: the branch exists and points at a commit Oxagen cannot reuse.
    if (created.status === 422)
      await t.rest.request("PATCH", `${root}/git/refs/heads/${refPath(branch)}`, {
        sha: head,
        force: true,
      });
  }

  const number = await githubRevertPull(
    t,
    branch,
    published,
    divergence,
    previous,
  );

  if (!reused || !(await githubHasRevertCheck(t, head)))
    await t.rest.request("POST", `${root}/check-runs`, {
      name: REQUIRED_CHECK_NAME,
      head_sha: head,
      status: "completed",
      conclusion: "success",
      external_id: REVERT_CHECK_EXTERNAL_ID,
      output: {
        title: revertTitle(published.version),
        summary: revertSummary(published),
      },
    });

  if (previous !== null && previous !== number)
    await githubCloseRevert(t, previous);
  return number;
}

/** Close a revert pull request. Any other pull request stays as it is. */
export async function githubCloseRevert(
  t: GithubHistoryTarget,
  number: number,
): Promise<void> {
  const path = `${githubRoot(t)}/pulls/${seg(number)}`;
  const res = await t.rest.request<GithubPull>("GET", path, undefined, [404]);
  if (res.data?.state !== "open" || !isRevertBranch(res.data.head.ref)) return;
  await t.rest.request("PATCH", path, { state: "closed" });
}

// ── GitLab ───────────────────────────────────────────────────────────────────

export interface GitlabHistoryTarget {
  rest: GitlabRest;
  projectId: number;
  bot: SteeringBot;
}

interface GitlabDeployment {
  sha: string;
  user?: { id?: number } | null;
}

interface GitlabCommit {
  id: string;
  message: string;
  parent_ids: string[];
}

interface GitlabBranch {
  commit: { id: string; parent_ids?: string[] | null };
}

interface GitlabDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

interface GitlabCompare {
  commits: GitlabCommit[];
  diffs: GitlabDiff[];
  compare_timeout?: boolean;
}

interface GitlabMergeRequest {
  iid: number;
  state: string;
  source_branch: string;
  target_branch: string;
}

type GitlabAction =
  | { action: "delete"; file_path: string }
  | {
      action: "create" | "update";
      file_path: string;
      content: string;
      encoding: "base64";
    }
  | {
      action: "move";
      previous_path: string;
      file_path: string;
      content: string;
      encoding: "base64";
    };

function gitlabRoot(t: GitlabHistoryTarget): string {
  return `/projects/${seg(t.projectId)}`;
}

async function gitlabCommit(
  t: GitlabHistoryTarget,
  sha: string,
): Promise<GitlabCommit> {
  const res = await t.rest.request<GitlabCommit>(
    "GET",
    `${gitlabRoot(t)}/repository/commits/${seg(sha)}`,
  );
  return need(res.data, "GitLab commit");
}

async function gitlabMainSha(t: GitlabHistoryTarget): Promise<string> {
  const res = await t.rest.request<GitlabBranch>(
    "GET",
    `${gitlabRoot(t)}/repository/branches/${seg(STEERING_DEFAULT_BRANCH)}`,
  );
  return need(res.data, "GitLab branch").commit.id;
}

/** The straight compare of two commits' files. */
async function gitlabCompare(
  t: GitlabHistoryTarget,
  from: string,
  to: string,
): Promise<GitlabCompare> {
  const res = await t.rest.request<GitlabCompare>(
    "GET",
    `${gitlabRoot(t)}/repository/compare?from=${seg(from)}&to=${seg(to)}&straight=true`,
  );
  return need(res.data, "GitLab compare");
}

function sameFiles(compare: GitlabCompare): boolean {
  return compare.compare_timeout !== true && compare.diffs.length === 0;
}

/**
 * The newest deployment the steering bot recorded, or null. GitLab records
 * no version on a deployment, so the version comes from the commit's trailer.
 */
export async function gitlabPublished(
  t: GitlabHistoryTarget,
): Promise<PublishedCommit | null> {
  const res = await t.rest.request<GitlabDeployment[]>(
    "GET",
    `${gitlabRoot(t)}/deployments?environment=${seg(STEERING_ENVIRONMENT)}&status=success&order_by=id&sort=desc&per_page=${GITLAB_DEPLOYMENT_PAGE}`,
  );
  const hit = (res.data ?? []).find((d) => d.user?.id === t.bot.user_id);
  if (hit === undefined) return null;
  const { message } = await gitlabCommit(t, hit.sha);
  const version =
    versionTrailer(message) ??
    (message.startsWith(FIRST_COMMIT_MESSAGE) ? FIRST_VERSION : null);
  return { sha: hit.sha, version };
}

/**
 * The index of the newest revert commit whose files equal the published
 * commit's, or -1. GitLab commits carry no tree, so each probe is a compare.
 */
async function gitlabRestoredAt(
  t: GitlabHistoryTarget,
  publishedSha: string,
  commits: readonly HistoryCommit[],
): Promise<number> {
  let probes = 0;
  for (let index = commits.length - 1; index >= 0; index--) {
    const commit = commits[index];
    if (commit === undefined || revertTrailer(commit.message) === null) continue;
    if (probes === RESTORE_PROBES) break;
    probes++;
    if (sameFiles(await gitlabCompare(t, commit.sha, publishedSha))) return index;
  }
  return -1;
}

/** Whether main holds commits Oxagen did not merge since `published`. */
export async function gitlabDiverged(
  t: GitlabHistoryTarget,
  published: PublishedCommit,
): Promise<Divergence | null> {
  const main = await gitlabMainSha(t);
  if (main === published.sha) return null;
  const gone = (): Divergence | null =>
    judgeHistory(published, {
      status: "diverged",
      commits: [],
      truncated: false,
      main_sha: main,
      restored_at: -1,
    });
  // 400: GitLab no longer knows the published commit. 404: no merge base.
  const base = await t.rest.request<{ id: string }>(
    "GET",
    `${gitlabRoot(t)}/repository/merge_base?refs[]=${seg(published.sha)}&refs[]=${seg(main)}`,
    undefined,
    [400, 404],
  );
  if (base.data === null) return gone();
  const compare = await gitlabCompare(t, published.sha, main);
  // Main holds the published files, so there is nothing to put back.
  if (sameFiles(compare)) return null;
  if (base.data.id !== published.sha) return gone();
  // Order the commits oldest first: main's own commit comes last.
  const listed =
    compare.commits[0]?.id === main ? [...compare.commits].reverse() : compare.commits;
  const commits: HistoryCommit[] = listed.map((commit) => ({
    sha: commit.id,
    parents: commit.parent_ids,
    message: commit.message,
  }));
  const truncated = compare.compare_timeout === true;
  return judgeHistory(published, {
    status: "ahead",
    commits,
    truncated,
    main_sha: main,
    restored_at: truncated ? -1 : await gitlabRestoredAt(t, published.sha, commits),
  });
}

async function gitlabFileContent(
  t: GitlabHistoryTarget,
  path: string,
  ref: string,
): Promise<string> {
  const res = await t.rest.request<{ content: string }>(
    "GET",
    `${gitlabRoot(t)}/repository/files/${seg(path)}?ref=${seg(ref)}`,
  );
  return need(res.data, `GitLab file ${path}`).content;
}

/** The commit action that turns one file on main into the published file. */
async function gitlabAction(
  t: GitlabHistoryTarget,
  diff: GitlabDiff,
  publishedSha: string,
): Promise<GitlabAction> {
  if (diff.deleted_file) return { action: "delete", file_path: diff.old_path };
  const content = await gitlabFileContent(t, diff.new_path, publishedSha);
  if (diff.renamed_file)
    return {
      action: "move",
      previous_path: diff.old_path,
      file_path: diff.new_path,
      content,
      encoding: "base64",
    };
  return {
    action: diff.new_file ? "create" : "update",
    file_path: diff.new_path,
    content,
    encoding: "base64",
  };
}

/** Write the revert commit on `branch`, on top of main. Returns its sha. */
async function gitlabWriteRevert(
  t: GitlabHistoryTarget,
  published: PublishedCommit,
  main: string,
  branch: string,
): Promise<string> {
  const compare = await gitlabCompare(t, main, published.sha);
  if (compare.compare_timeout === true)
    throw new Error(
      `GitLab timed out comparing main with the published commit ${short(published.sha)}, so Oxagen cannot write the revert commit.`,
    );
  const actions: GitlabAction[] = [];
  for (const diff of compare.diffs)
    actions.push(await gitlabAction(t, diff, published.sha));
  if (actions.length === 0)
    throw new Error(
      `The branch main already holds the files of the published commit ${short(published.sha)}, so there is nothing to revert.`,
    );
  const res = await t.rest.request<{ id: string }>(
    "POST",
    `${gitlabRoot(t)}/repository/commits`,
    {
      branch,
      start_sha: main,
      commit_message: revertMessage(published),
      actions,
      force: true,
    },
  );
  return need(res.data, "GitLab commit").id;
}

/**
 * Find the open merge request from `branch` into main. Close every open merge
 * request from `branch` into another branch, because Repair refuses to merge
 * one and Oxagen opens a new one into main in its place.
 */
async function gitlabFindRequest(
  t: GitlabHistoryTarget,
  branch: string,
): Promise<number | null> {
  const root = gitlabRoot(t);
  const res = await t.rest.request<GitlabMergeRequest[]>(
    "GET",
    `${root}/merge_requests?state=opened&source_branch=${seg(branch)}`,
  );
  let found: number | null = null;
  for (const mr of res.data ?? []) {
    if (mr.source_branch !== branch) continue;
    if (mr.target_branch === STEERING_DEFAULT_BRANCH) {
      if (found === null) found = mr.iid;
      continue;
    }
    // Close it first, so the branch never has two open merge requests.
    await t.rest.request("PUT", `${root}/merge_requests/${seg(mr.iid)}`, {
      state_event: "close",
    });
  }
  return found;
}

async function gitlabRevertRequest(
  t: GitlabHistoryTarget,
  branch: string,
  published: PublishedCommit,
  divergence: Divergence,
  previous: number | null,
): Promise<number> {
  const root = gitlabRoot(t);
  if (previous !== null) {
    const prev = await t.rest.request<GitlabMergeRequest>(
      "GET",
      `${root}/merge_requests/${seg(previous)}`,
      undefined,
      [404],
    );
    if (
      prev.data?.state === "opened" &&
      prev.data.source_branch === branch &&
      prev.data.target_branch === STEERING_DEFAULT_BRANCH
    )
      return previous;
  }
  const found = await gitlabFindRequest(t, branch);
  if (found !== null) return found;
  const made = await t.rest.request<GitlabMergeRequest>(
    "POST",
    `${root}/merge_requests`,
    {
      source_branch: branch,
      target_branch: STEERING_DEFAULT_BRANCH,
      title: revertTitle(published.version),
      description: revertBody(published, divergence, "merge request"),
      remove_source_branch: true,
    },
    [409],
  );
  if (made.status !== 409) return need(made.data, "GitLab merge request").iid;
  // GitLab answers 409 when a merge request for the branch opened since the list.
  const again = await gitlabFindRequest(t, branch);
  if (again === null)
    throw new Error(
      `GitLab refused the revert merge request for ${branch}: ${made.message ?? "status 409"}`,
    );
  return again;
}

/**
 * Open, or find, the merge request that puts main back at `published`, and
 * close `previous` when it is a different one. Returns its iid. A rerun
 * against an unchanged main writes no commit. Oxagen closes a revert merge
 * request someone retargeted away from main and opens a new one into main.
 */
export async function gitlabOpenRevert(
  t: GitlabHistoryTarget,
  published: PublishedCommit,
  divergence: Divergence,
  previous: number | null,
): Promise<number> {
  const root = gitlabRoot(t);
  const main = divergence.main_sha;
  const branch = revertBranch(published.sha, main);

  // Reuse the branch when its head holds the published files on top of main.
  let head: string | null = null;
  const existing = await t.rest.request<GitlabBranch>(
    "GET",
    `${root}/repository/branches/${seg(branch)}`,
    undefined,
    [404],
  );
  if (existing.data !== null) {
    const tip = existing.data.commit;
    const parents = tip.parent_ids ?? [];
    if (
      parents.length === 1 &&
      parents[0] === main &&
      sameFiles(await gitlabCompare(t, tip.id, published.sha))
    )
      head = tip.id;
  }
  if (head === null) head = await gitlabWriteRevert(t, published, main, branch);

  const iid = await gitlabRevertRequest(
    t,
    branch,
    published,
    divergence,
    previous,
  );

  // 400: the commit already carries this status.
  await t.rest.request(
    "POST",
    `${root}/statuses/${seg(head)}`,
    {
      state: "success",
      name: REQUIRED_CHECK_NAME,
      description: revertSummary(published),
    },
    [400],
  );

  if (previous !== null && previous !== iid) await gitlabCloseRevert(t, previous);
  return iid;
}

/** Close a revert merge request. Any other merge request stays as it is. */
export async function gitlabCloseRevert(
  t: GitlabHistoryTarget,
  iid: number,
): Promise<void> {
  const path = `${gitlabRoot(t)}/merge_requests/${seg(iid)}`;
  const res = await t.rest.request<GitlabMergeRequest>(
    "GET",
    path,
    undefined,
    [404],
  );
  if (res.data?.state !== "opened" || !isRevertBranch(res.data.source_branch))
    return;
  await t.rest.request("PUT", path, { state_event: "close" });
}
