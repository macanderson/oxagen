// run-issues-tracker.ts — the GitHub reads behind get_run_issues (#3970,
// ADR-197): the issues each pull request the run recorded opening closes, and
// each issue's title and state as GitHub reads it now.
//
// Both reads go through the workspace's connection for the repository
// (`resolveGitHubToken` with its `connectionId`), never a token of another
// workspace. An issue's state is cached in process for 60 seconds, keyed by
// organization, workspace, repository and number, so a reload inside the
// minute reads GitHub once and one workspace never reads another's answer.
// The cache keeps the time GitHub answered, and that is the `readAt` a row
// reports.
import {
  createGitHubClient,
  type GitHubClient,
  type GitHubClosingIssue,
} from "@oxagen/github";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import type { RunIssue } from "@oxagen/oxagen/contracts/run.issues.get";
import type { RunRepository } from "@oxagen/oxagen/contracts/run.work.get";
import type { RunScope } from "../run.list";
import { logger } from "../logger";
import { connectionOf } from "./run-command-refs";
import type { ConnectedRunRepository } from "./run-work";

export type IssueStatusRead = RunIssue["statusRead"];

/** How long a state GitHub gave stays good for another read. */
export const ISSUE_STATE_TTL_MS = 60_000;
/** The most states the cache holds; the oldest goes first. */
export const ISSUE_STATE_CACHE_MAX = 1_000;
/** The most issues one run reads from GitHub per load. */
export const ISSUE_STATE_READ_MAX = 50;

/** One state GitHub gave, as the cache keeps it. */
interface CachedState {
  /** Epoch ms when GitHub answered; the TTL runs from here. */
  at: number;
  found: {
    title: string;
    state: "open" | "closed";
    url: string;
    isPullRequest: boolean;
  } | null;
}

/** The in-process state cache, one per process unless a caller brings its own. */
export type IssueStateCache = Map<string, CachedState>;

export function createIssueStateCache(): IssueStateCache {
  return new Map();
}

const processCache = createIssueStateCache();

export interface IssueTrackerDeps {
  client: (
    scope: RunScope,
    repository: ConnectedRunRepository,
  ) => Promise<Pick<GitHubClient, "getIssues" | "listClosingIssues">>;
  /** Epoch ms. */
  now: () => number;
  cache: IssueStateCache;
}

export const defaultIssueTrackerDeps: IssueTrackerDeps = {
  client: async (scope, repository) =>
    createGitHubClient({
      token: await resolveGitHubToken({
        ...scope,
        connectionId: repository.connectionId,
      }),
    }),
  now: () => Date.now(),
  cache: processCache,
};

/** One issue whose state the run's list asks for. */
export interface IssueStateRequest {
  /** The row's key; the answer is keyed the same way. */
  key: string;
  repository: RunRepository;
  number: number;
}

/** What the tracker read says about one issue. */
export interface IssueState {
  title: string | null;
  status: "open" | "closed" | null;
  statusRead: IssueStatusRead;
  /** RFC 3339: when GitHub answered; null when it was not read. */
  readAt: string | null;
  url: string | null;
  /** GitHub resolved the number to a pull request, not an issue. */
  isPullRequest: boolean;
}

const unread = (statusRead: IssueStatusRead): IssueState => ({
  title: null,
  status: null,
  statusRead,
  readAt: null,
  url: null,
  isPullRequest: false,
});

function stateOf(entry: CachedState): IssueState {
  if (entry.found === null) return unread("not_found");
  return {
    title: entry.found.title,
    status: entry.found.state,
    statusRead: "read",
    readAt: new Date(entry.at).toISOString(),
    url: entry.found.url,
    isPullRequest: entry.found.isPullRequest,
  };
}

function cacheKey(
  scope: RunScope,
  repository: { owner: string; name: string },
  number: number,
): string {
  return `${scope.orgId}:${scope.workspaceId}:${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}#${String(number)}`;
}

function remember(cache: IssueStateCache, key: string, entry: CachedState) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > ISSUE_STATE_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/**
 * Each requested issue's title and state from GitHub, by the row key the
 * request carried. An issue on another forge reads `not_github`, one in a
 * repository with no connection in this workspace reads `no_connection`, and
 * a state GitHub could not give reads `read_failed` or, past the 50-read cap,
 * `read_limit` with the `tracker_read_limit` warning. A cached answer inside
 * the TTL costs no read and no place under the cap.
 */
export async function readIssueStates(
  scope: RunScope,
  requests: readonly IssueStateRequest[],
  repositories: readonly ConnectedRunRepository[],
  deps: IssueTrackerDeps = defaultIssueTrackerDeps,
): Promise<{ states: Map<string, IssueState>; warnings: string[] }> {
  const states = new Map<string, IssueState>();
  const warnings = new Set<string>();
  const now = deps.now();
  // The issues to read from GitHub, by connected repository.
  const groups = new Map<
    string,
    {
      repository: ConnectedRunRepository;
      numbers: Map<number, string[]>;
    }
  >();
  let reads = 0;
  for (const request of requests) {
    if (request.repository.host !== "github.com") {
      states.set(request.key, unread("not_github"));
      continue;
    }
    const connected = connectionOf(request.repository, repositories);
    if (connected === undefined) {
      states.set(request.key, unread("no_connection"));
      continue;
    }
    const cached = deps.cache.get(cacheKey(scope, connected, request.number));
    if (cached !== undefined && now - cached.at < ISSUE_STATE_TTL_MS) {
      states.set(request.key, stateOf(cached));
      continue;
    }
    let group = groups.get(connected.url);
    if (group === undefined) {
      group = { repository: connected, numbers: new Map() };
      groups.set(connected.url, group);
    }
    const keys = group.numbers.get(request.number);
    if (keys !== undefined) {
      keys.push(request.key);
      continue;
    }
    if (reads >= ISSUE_STATE_READ_MAX) {
      states.set(request.key, unread("read_limit"));
      warnings.add("tracker_read_limit");
      continue;
    }
    reads += 1;
    group.numbers.set(request.number, [request.key]);
  }
  await Promise.all(
    [...groups.values()].map(async ({ repository, numbers }) => {
      if (numbers.size === 0) return;
      try {
        const gh = await deps.client(scope, repository);
        const answer = await gh.getIssues({
          owner: repository.owner,
          repo: repository.name,
          numbers: [...numbers.keys()],
        });
        const at = deps.now();
        for (const issue of answer.issues) {
          const entry: CachedState = {
            at,
            found: {
              title: issue.title,
              state: issue.state,
              url: issue.url,
              isPullRequest: issue.isPullRequest,
            },
          };
          remember(deps.cache, cacheKey(scope, repository, issue.number), entry);
          for (const key of numbers.get(issue.number) ?? [])
            states.set(key, stateOf(entry));
        }
        for (const number of answer.missing) {
          const entry: CachedState = { at, found: null };
          remember(deps.cache, cacheKey(scope, repository, number), entry);
          for (const key of numbers.get(number) ?? [])
            states.set(key, stateOf(entry));
        }
      } catch (error) {
        logger.warn(
          { err: error, orgId: scope.orgId, workspaceId: scope.workspaceId },
          "Run issue states could not be read",
        );
      }
      // A number GitHub answered neither way, or a failed read, is unread.
      for (const keys of numbers.values())
        for (const key of keys)
          if (!states.has(key)) states.set(key, unread("read_failed"));
    }),
  );
  return { states, warnings: [...warnings] };
}

/** A pull request whose closing issues the list reads. */
export interface ClosingPullRequest {
  repository: ConnectedRunRepository;
  number: number;
  url: string;
  /** The frame that recorded it; null when the record names none. */
  seq: string | null;
}

/**
 * The issues each pull request closes, as GitHub records its
 * `closingIssuesReferences`. Only the closing list is read: no checks, no
 * diff and no branch search. A failed read is `closing_issues_read_failed`
 * and a list GitHub cut short is `closing_issue_limit`, so an unread list
 * never reads as closing nothing.
 */
export async function readClosingIssues(
  scope: RunScope,
  pulls: readonly ClosingPullRequest[],
  deps: Pick<IssueTrackerDeps, "client"> = defaultIssueTrackerDeps,
): Promise<{
  closing: { pull: ClosingPullRequest; issues: GitHubClosingIssue[] }[];
  warnings: string[];
}> {
  const warnings = new Set<string>();
  const closing = await Promise.all(
    pulls.map(async (pull) => {
      try {
        const gh = await deps.client(scope, pull.repository);
        const list = await gh.listClosingIssues({
          owner: pull.repository.owner,
          repo: pull.repository.name,
          number: pull.number,
        });
        if (!list.complete) warnings.add("closing_issue_limit");
        return { pull, issues: list.issues };
      } catch (error) {
        logger.warn(
          { err: error, orgId: scope.orgId, workspaceId: scope.workspaceId },
          "Run pull request closing issues could not be read",
        );
        warnings.add("closing_issues_read_failed");
        return { pull, issues: [] };
      }
    }),
  );
  return { closing, warnings: [...warnings] };
}
