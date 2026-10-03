// diverged.ts: whether main holds commits Oxagen did not merge, and the pull
// request that puts main back at the published commit.
//
// GitHub provenance comes from the host's merged pull request records. Commit
// messages and authors cannot prove who merged a change. A `(#N)` at the end
// of a title only says which pull request record to read. Equal tree hashes
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
import { HandlerError } from "@oxagen/oxagen";
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

/**
 * The check run adopt_steering_merges posts on each host merge a person
 * adopted in Oxagen (#5195). GitHub lets only the steering app post a run
 * under its app id, so the run is the record the history judge reads, and
 * nothing is written into the repository's history.
 */
export const ADOPTION_CHECK_NAME = "Oxagen steering adoption";
const ADOPTION_CHECK_EXTERNAL_ID = "oxagen-steering-adoption";
/** Files a commit read lists before GitHub cuts the list. */
const COMMIT_FILES_LIMIT = 300;
/** Pages of 100 files a pull request read takes before it gives up. */
const PULL_FILE_PAGES = 30;

const SHORT_SHA = 7;
/** Commits one GitHub compare page holds. More than this reads as truncated. */
const COMPARE_PAGE = 100;
const GITHUB_DEPLOYMENT_PAGE = 30;
const GITLAB_DEPLOYMENT_PAGE = 20;
/**
 * Pages of deployments a lookup reads before it gives up. Another actor can
 * deploy to the steering environment too, so Oxagen's newest record can sit
 * past the first page (#4653).
 */
const DEPLOYMENT_PAGES = 10;
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

/** `&page=N` for every page after the first, which keeps the first page's path as it was. */
function pageParam(page: number): string {
  return page === 1 ? "" : `&page=${page}`;
}

/**
 * The first deployment `owned` accepts, newest first, read a page at a time.
 * Null when the host runs out of deployments first. A lookup that reads
 * DEPLOYMENT_PAGES full pages without one throws, because "none recorded"
 * and "not read" are different answers (#4653).
 */
async function findDeployment<T>(
  read: (page: number) => Promise<T[]>,
  owned: (deployment: T) => boolean,
  perPage: number,
  host: string,
): Promise<T | null> {
  for (let page = 1; page <= DEPLOYMENT_PAGES; page++) {
    const rows = await read(page);
    const hit = rows.find(owned);
    if (hit !== undefined) return hit;
    if (rows.length < perPage) return null;
  }
  throw new Error(
    `${host} lists more than ${DEPLOYMENT_PAGES * perPage} deployments to the steering environment since Oxagen's last publish, so Oxagen cannot find the commit it published.`,
  );
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
  /** The clock a fresh merge is judged by. Defaults to `Date.now`. */
  now?: () => number;
  /** Waits between re-checks of a fresh merge. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * GitHub's API does not prove a merge the moment it lands. For a few seconds
 * a read can miss the pull request behind a commit Oxagen merged moments
 * earlier, so the same check on the same commit passed and then failed within
 * one merge on 2026-10-02, and in a second run failed first (#5157). An exact
 * commit committed less than FRESH_MERGE_MS ago is therefore checked up to
 * RECHECK_READS times, RECHECK_INTERVAL_MS apart, before Oxagen refuses it.
 * An older commit is refused on the first read.
 */
const FRESH_MERGE_MS = 60_000;
const RECHECK_READS = 6;
const RECHECK_INTERVAL_MS = 1_500;

interface GithubDeployment {
  sha: string;
  description?: string | null;
  payload?: unknown;
  performed_via_github_app?: { id?: number; slug?: string } | null;
  creator?: { login?: string; type?: string } | null;
}

/**
 * Whether the app made this deployment. GitHub fills
 * `performed_via_github_app` on some deployments and leaves it null on one
 * made with the app's installation token, which records the app's bot user as
 * the creator instead (seen on `oxageninc/oxagen-gtm` on 2026-10-01). A
 * `<slug>[bot]` login belongs only to that app, so either field anchors it.
 * When GitHub names an app, its slug and id must match.
 */
function madeByApp(d: GithubDeployment, app: GithubHistoryTarget["app"]): boolean {
  const via = d.performed_via_github_app;
  if (via !== null && via !== undefined)
    return via.slug === app.slug && (via.id === undefined || via.id === app.id);
  return d.creator?.type === "Bot" && d.creator.login === `${app.slug}[bot]`;
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
  committer?: { date?: string } | null;
}

interface GithubPull {
  number: number;
  state: string;
  head: { ref: string };
  base: { ref: string };
}

interface GithubCheckRuns {
  check_runs: {
    external_id?: string | null;
    conclusion?: string | null;
    app?: { id?: number } | null;
  }[];
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
  const hit = await findDeployment(
    async (page) =>
      (
        await t.rest.request<GithubDeployment[]>(
          "GET",
          `${githubRoot(t)}/deployments?environment=${seg(STEERING_ENVIRONMENT)}&per_page=${GITHUB_DEPLOYMENT_PAGE}${pageParam(page)}`,
        )
      ).data ?? [],
    (d) => madeByApp(d, t.app),
    GITHUB_DEPLOYMENT_PAGE,
    "GitHub",
  );
  if (hit === null) return null;
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
  head?: { sha?: string } | null;
  merged_by?: { type?: string; login?: string } | null;
}

/** One file a commit or a pull request changes, as GitHub lists it. */
interface GithubChangedFile {
  filename: string;
  status: string;
  sha?: string | null;
  previous_filename?: string | null;
}

/** `Title (#12)`: the pull request number GitHub and Oxagen put on a squash title. */
const TITLE_PULL = /\(#(\d+)\)[ \t]*\r?$/;

/** The pull request number at the end of the message's first line, or null. */
function titlePull(message: string): number | null {
  const title = message.split("\n", 1)[0] ?? "";
  const number = parseVersion(TITLE_PULL.exec(title)?.[1]);
  return number !== null && number > 0 ? number : null;
}

/**
 * The pull requests that may have merged as `sha`: those GitHub lists for the
 * commit, and the one its title names.
 *
 * GitHub fills in a commit's list of pull requests a few seconds after the
 * merge, so a read just after Oxagen merges finds none (#5157). Every merge
 * Oxagen makes ends its title with `(#N)`, so pull request N is read as well.
 * The title only says which pull request to read. The proof is the pull
 * request itself (see `mergedAs`). A forged title can name a real pull
 * request, but that pull request's merge commit is another commit, so the
 * forged one still fails.
 */
async function candidatePulls(
  t: GithubHistoryTarget,
  sha: string,
  message: string,
): Promise<number[]> {
  const listed = await t.rest.request<{ number: number }[]>(
    "GET",
    `${githubRoot(t)}/commits/${seg(sha)}/pulls?per_page=100`,
  );
  const numbers = need(listed.data, "GitHub commit pull requests").map(
    (summary) => summary.number,
  );
  const named = titlePull(message);
  if (named !== null && !numbers.includes(named)) numbers.push(named);
  return numbers;
}

async function githubPull(
  t: GithubHistoryTarget,
  number: number,
): Promise<GithubMergedPull> {
  const response = await t.rest.request<GithubMergedPull>(
    "GET",
    `${githubRoot(t)}/pulls/${seg(number)}`,
  );
  return need(response.data, "GitHub pull request");
}

/** Whether GitHub says `pull` merged into this repository's production branch as exactly `sha`. */
function mergedAs(t: GithubHistoryTarget, pull: GithubMergedPull, sha: string): boolean {
  const repo = pull.base?.repo;
  const sameRepo =
    t.repo.id !== undefined
      ? repo?.id === t.repo.id
      : repo?.full_name?.toLowerCase() ===
        `${t.repo.owner}/${t.repo.name}`.toLowerCase();
  return (
    pull.merged === true &&
    pull.merge_commit_sha === sha &&
    pull.base?.ref === (t.defaultBranch ?? STEERING_DEFAULT_BRANCH) &&
    sameRepo
  );
}

function mergedByApp(t: GithubHistoryTarget, pull: GithubMergedPull): boolean {
  return (
    pull.merged_by?.type === "Bot" &&
    pull.merged_by.login === `${t.app.slug}[bot]`
  );
}

/** Whether the steering app posted the adoption check run on `sha` (#5195). */
async function githubAdopted(t: GithubHistoryTarget, sha: string): Promise<boolean> {
  const res = await t.rest.request<GithubCheckRuns>(
    "GET",
    `${githubRoot(t)}/commits/${seg(sha)}/check-runs?check_name=${seg(ADOPTION_CHECK_NAME)}&app_id=${seg(t.app.id)}`,
  );
  return (res.data?.check_runs ?? []).some(
    (run) =>
      run.external_id === ADOPTION_CHECK_EXTERNAL_ID &&
      run.conclusion === "success" &&
      run.app?.id === t.app.id,
  );
}

/**
 * Authenticate the merge against the full pull request returned by GitHub:
 * GitHub must say the app merged it into this repository's production branch
 * as exactly this commit.
 *
 * A pull request a person merged on the host proves nothing about who
 * approved it. It counts only once a person the governance mode lets merge
 * adopted it in Oxagen, which leaves the app's adoption check run on the
 * commit (adopt_steering_merges, #5195). A commit no pull request merged, such
 * as a push past the branch rules, never counts.
 */
async function githubAuthenticatedMerge(
  t: GithubHistoryTarget,
  sha: string,
  message: string,
): Promise<boolean> {
  let hostMerged = false;
  for (const number of await candidatePulls(t, sha, message)) {
    const pull = await githubPull(t, number);
    if (!mergedAs(t, pull, sha)) continue;
    if (mergedByApp(t, pull)) return true;
    hostMerged = true;
  }
  return hostMerged && (await githubAdopted(t, sha));
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
          ? await githubAuthenticatedMerge(t, commit.sha, commit.commit.message)
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

/**
 * Whether GitHub records `sha` as committed less than FRESH_MERGE_MS ago. A
 * commit GitHub cannot date counts as old, so its refusal is not delayed.
 */
async function committedMomentsAgo(
  t: GithubHistoryTarget,
  sha: string,
): Promise<boolean> {
  const at = Date.parse((await githubCommit(t, sha)).committer?.date ?? "");
  if (Number.isNaN(at)) return false;
  return (t.now ?? Date.now)() - at < FRESH_MERGE_MS;
}

/**
 * Refuse an exact commit unless it descends safely from an app deployment.
 * Both refusals are `conflict`s the caller can show, not a server error: a
 * repository Oxagen cannot vouch for is a state of the repository (#5157).
 * A commit made moments ago is checked again a few times first, because
 * GitHub can take a few seconds to prove a merge it just made.
 */
export async function assertGithubSteeringCommit(
  t: GithubHistoryTarget,
  commit: string,
): Promise<void> {
  const published = await githubPublished(t);
  if (published === null)
    throw new HandlerError({
      code: "conflict",
      reason: "steering_publication_missing",
      message: `Oxagen found no steering version its GitHub App published in ${t.repo.owner}/${t.repo.name}, so it cannot check who merged steering commit ${short(commit)}. Oxagen publishes nothing from that commit.`,
    });
  let divergence = await githubDiverged(t, published, commit);
  if (divergence !== null && (await committedMomentsAgo(t, commit))) {
    const sleep =
      t.sleep ??
      ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
    for (
      let read = 1;
      divergence !== null && read < RECHECK_READS;
      read += 1
    ) {
      await sleep(RECHECK_INTERVAL_MS);
      divergence = await githubDiverged(t, published, commit);
    }
  }
  if (divergence !== null)
    throw new HandlerError({
      code: "conflict",
      reason: "steering_commit_unproven",
      message: `Oxagen cannot accept steering commit ${short(commit)}: ${divergence.reason}. Oxagen publishes nothing from that commit. Check the steering repo's health in Oxagen before you merge again.`,
    });
}

/**
 * Find the open pull request from `branch` into main. Close every open pull
 * request from `branch` into another branch, because Repair refuses to merge
 * one and Oxagen opens a new one into main in its place. Each close is read
 * back, and a pull request GitHub still shows open throws, so the caller
 * writes nothing on `branch` (#4671).
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
    const path = `${root}/pulls/${seg(pull.number)}`;
    await t.rest.request("PATCH", path, { state: "closed" });
    const after = await t.rest.request<GithubPull>("GET", path);
    if (after.data?.state !== "closed")
      throw new Error(
        `GitHub still shows pull request #${pull.number} from ${branch} into ${pull.base.ref} as open, so Oxagen wrote nothing to ${branch}.`,
      );
  }
  return found;
}

/** Open the revert pull request from `branch` into main. Returns its number. */
async function githubCreatePull(
  t: GithubHistoryTarget,
  branch: string,
  published: PublishedCommit,
  divergence: Divergence,
): Promise<number> {
  const root = githubRoot(t);
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
 *
 * The order of the writes matters (#4671). A pull request from the revert
 * branch into another branch merges whatever the branch holds into the branch
 * its retargeter chose. If Oxagen moved the branch first, auto-merge or a
 * person could land the app's revert commit there before Oxagen closed the
 * pull request. So every such pull request is closed, and read back as
 * closed, before Oxagen writes a commit, the branch, or the check run. A
 * close that fails throws, and the branch stays as it was. A pull request
 * retargeted after the list is not seen until the next health read.
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
  const open = await githubFindPull(t, branch);
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

  const number = open ?? (await githubCreatePull(t, branch, published, divergence));

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

// ── Adoption (GitHub) ────────────────────────────────────────────────────────

/** A commit on main after the published one that no app merge or adoption proves. */
export interface UnprovenCommit {
  sha: string;
  message: string;
}

/**
 * The commits on main since `published` that the history judge would call
 * foreign, oldest first, or why Oxagen cannot list them. Only a main that is
 * ahead of the published commit can be adopted: a rewritten or truncated
 * history has no list of merges to prove.
 */
export async function githubUnproven(
  t: GithubHistoryTarget,
  published: PublishedCommit,
): Promise<{ main_sha: string; commits: UnprovenCommit[] } | { refused: string }> {
  const p7 = short(published.sha);
  const res = await t.rest.request<GithubCompare>(
    "GET",
    `${githubRoot(t)}/compare/${seg(published.sha)}...${seg(t.defaultBranch ?? STEERING_DEFAULT_BRANCH)}?per_page=${COMPARE_PAGE}`,
    undefined,
    [404],
  );
  if (res.status === 404)
    return { refused: `main no longer contains the published commit ${p7}` };
  const compare = need(res.data, "GitHub compare");
  if (compare.status === "identical")
    return { main_sha: published.sha, commits: [] };
  if (compare.status !== "ahead")
    return { refused: `main no longer contains the published commit ${p7}` };
  if (compare.commits.length < compare.total_commits)
    return {
      refused: `main holds more commits since the published commit ${p7} than Oxagen can read`,
    };
  const baseTree = compare.base_commit.commit.tree.sha;
  let restored_at = -1;
  compare.commits.forEach((commit, index) => {
    if (commit.commit.tree.sha === baseTree) restored_at = index;
  });
  const commits: UnprovenCommit[] = [];
  for (const commit of compare.commits.slice(restored_at + 1))
    if (!(await githubAuthenticatedMerge(t, commit.sha, commit.commit.message)))
      commits.push({ sha: commit.sha, message: commit.commit.message });
  const last = compare.commits.at(-1);
  return { main_sha: last?.sha ?? published.sha, commits };
}

/** The pull request a person merged on the host as one commit, and the head it merged. */
export interface HostMerge {
  number: number;
  headSha: string;
}

/**
 * The pull request GitHub says merged into this repository's production
 * branch as exactly `sha`, by someone other than the steering app, or null.
 */
export async function githubHostMerge(
  t: GithubHistoryTarget,
  commit: UnprovenCommit,
): Promise<HostMerge | null> {
  for (const number of await candidatePulls(t, commit.sha, commit.message)) {
    const pull = await githubPull(t, number);
    const headSha = pull.head?.sha;
    if (mergedAs(t, pull, commit.sha) && !mergedByApp(t, pull) && typeof headSha === "string")
      return { number, headSha };
  }
  return null;
}

function changeKey(file: GithubChangedFile): string {
  return [file.status, file.filename, file.previous_filename ?? "", file.sha ?? ""].join("\t");
}

/**
 * Whether merge commit `sha` changes exactly what pull request `number`
 * changes: the same paths, with the same status and the same blob. The
 * commit is compared with its first parent, so a pull request merged after
 * another one still matches when the two touched different files. A list
 * GitHub cuts short proves nothing, so it answers false.
 */
export async function githubSameChanges(
  t: GithubHistoryTarget,
  sha: string,
  number: number,
): Promise<boolean> {
  const root = githubRoot(t);
  const commit = await t.rest.request<{ files?: GithubChangedFile[] }>(
    "GET",
    `${root}/commits/${seg(sha)}`,
  );
  const merged = need(commit.data, "GitHub commit").files ?? [];
  if (merged.length >= COMMIT_FILES_LIMIT) return false;
  const proposed: GithubChangedFile[] = [];
  for (let page = 1; ; page++) {
    if (page > PULL_FILE_PAGES) return false;
    const res = await t.rest.request<GithubChangedFile[]>(
      "GET",
      `${root}/pulls/${seg(number)}/files?per_page=100${pageParam(page)}`,
    );
    const rows = need(res.data, "GitHub pull request files");
    proposed.push(...rows);
    if (rows.length < 100) break;
  }
  const a = merged.map(changeKey).sort();
  const b = proposed.map(changeKey).sort();
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/**
 * Post the adoption check run on `sha`, so every later history read counts
 * the commit as Oxagen's (#5195). `summary` names who adopted it and from
 * which pull request.
 */
export async function githubRecordAdoption(
  t: GithubHistoryTarget,
  sha: string,
  summary: string,
): Promise<void> {
  await t.rest.request("POST", `${githubRoot(t)}/check-runs`, {
    name: ADOPTION_CHECK_NAME,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    external_id: ADOPTION_CHECK_EXTERNAL_ID,
    output: { title: "Adopted in Oxagen", summary },
  });
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
  const hit = await findDeployment(
    async (page) =>
      (
        await t.rest.request<GitlabDeployment[]>(
          "GET",
          `${gitlabRoot(t)}/deployments?environment=${seg(STEERING_ENVIRONMENT)}&status=success&order_by=id&sort=desc&per_page=${GITLAB_DEPLOYMENT_PAGE}${pageParam(page)}`,
        )
      ).data ?? [],
    (d) => d.user?.id === t.bot.user_id,
    GITLAB_DEPLOYMENT_PAGE,
    "GitLab",
  );
  if (hit === null) return null;
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
 * one and Oxagen opens a new one into main in its place. Each close is read
 * back, and a merge request GitLab still shows open throws, so the caller
 * writes nothing on `branch` (#4671).
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
    const path = `${root}/merge_requests/${seg(mr.iid)}`;
    await t.rest.request("PUT", path, { state_event: "close" });
    const after = await t.rest.request<GitlabMergeRequest>("GET", path);
    if (after.data?.state !== "closed")
      throw new Error(
        `GitLab still shows merge request !${mr.iid} from ${branch} into ${mr.target_branch} as open, so Oxagen wrote nothing to ${branch}.`,
      );
  }
  return found;
}

/** Open the revert merge request from `branch` into main. Returns its iid. */
async function gitlabCreateRequest(
  t: GitlabHistoryTarget,
  branch: string,
  published: PublishedCommit,
  divergence: Divergence,
): Promise<number> {
  const root = gitlabRoot(t);
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
 *
 * Every such merge request is closed, and read back as closed, before Oxagen
 * writes the revert commit, which force-moves the branch, or the status, for
 * the reason githubOpenRevert gives (#4671). A close that fails throws, and
 * the branch stays as it was.
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
  const open = await gitlabFindRequest(t, branch);

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

  const iid = open ?? (await gitlabCreateRequest(t, branch, published, divergence));

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
