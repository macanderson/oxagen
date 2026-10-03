import { createGitHubClient, type GitHubClient } from "@oxagen/github";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import type {
  RunCheckout,
  RunWorkPr,
} from "@oxagen/oxagen/contracts/run.work.get";
import type { RunStore } from "@oxagen/run-ledger";
import type { RunScope } from "../run.list";
import { logger } from "../logger";
import { buildCiSummary } from "./ci-status";
import { type ConnectedRunRepository, workDigest } from "./run-work";

/**
 * A pull request the run's record names in a repository the workspace links,
 * by the provider's repository id. The read finds the repository among the
 * linked ones by `providerRepositoryId`.
 */
export interface LinkedRunPr {
  repositoryId: string;
  number: number;
  headSha: string | null;
  /** The ledger event that recorded it (`run_seq`), where the reader has one. */
  seq?: string;
}

/**
 * A pull request the run's record names in a repository the workspace does
 * not link. The caller has already found the workspace's own GitHub
 * connection that reads the repository's owner, as the ADR-192 backfill does,
 * so the read takes the repository as given. Its `connected` is false.
 */
export interface UnlinkedRunPr {
  repository: ConnectedRunRepository;
  number: number;
  headSha: string | null;
}

/** A pull request the run's record names outright. */
export type RecordedRunPr = LinkedRunPr | UnlinkedRunPr;

/** The ledger events one page reads, and the pages one read walks. */
const LEDGER_EVENT_PAGE = 500;
const LEDGER_EVENT_PAGES = 20;

/**
 * The pull requests a ledger run recorded opening, from its
 * `provider_publish.pull_request_opened` events, walked 500 at a time for at
 * most 20 pages. `complete` is false when the walk stopped at that bound, so
 * a caller says the list may be short (`ledger_event_limit`). Shared by
 * `get_run_work` and `get_run_issues`, which read the same receipts.
 */
export async function readLedgerPrReceipts(
  store: Pick<RunStore, "readAttemptEventsSince">,
  runId: string,
): Promise<{ receipts: LinkedRunPr[]; complete: boolean }> {
  const receipts: LinkedRunPr[] = [];
  let cursor = "0";
  for (let page = 0; page < LEDGER_EVENT_PAGES; page++) {
    const events = await store.readAttemptEventsSince(
      runId,
      cursor,
      LEDGER_EVENT_PAGE,
    );
    for (const event of events) {
      if (
        event.eventType !== "provider_publish.pull_request_opened" ||
        typeof event.payload !== "object" ||
        event.payload === null
      )
        continue;
      const payload = event.payload as Record<string, unknown>;
      if (
        typeof payload.provider_repository_id !== "string" ||
        typeof payload.pull_request_number !== "number"
      )
        continue;
      receipts.push({
        repositoryId: payload.provider_repository_id,
        number: payload.pull_request_number,
        headSha:
          typeof payload.head_commit_sha === "string"
            ? payload.head_commit_sha
            : null,
        seq: event.runSeq,
      });
    }
    const last = events.at(-1);
    if (events.length < LEDGER_EVENT_PAGE || last === undefined)
      return { receipts, complete: true };
    cursor = last.runSeq;
  }
  return { receipts, complete: false };
}
const PR_CAP = 20;
const DIFF_BYTES_CAP = 512 * 1024;
export interface WorkPrDeps {
  client: (
    scope: RunScope,
    repository: ConnectedRunRepository,
  ) => Promise<
    Pick<
      GitHubClient,
      | "listPullRequests"
      | "getPullRequest"
      | "listClosingIssues"
      | "listCiChecks"
      | "listPullRequestFiles"
      | "getRepoInfo"
    >
  >;
  now: () => string;
}
export const defaultWorkPrDeps: WorkPrDeps = {
  client: async (scope, repository) =>
    createGitHubClient({
      token: await resolveGitHubToken({
        ...scope,
        connectionId: repository.connectionId,
      }),
    }),
  now: () => new Date().toISOString(),
};

export async function readWorkPullRequests(
  scope: RunScope,
  checkouts: readonly RunCheckout[],
  repositories: readonly ConnectedRunRepository[],
  deps: WorkPrDeps = defaultWorkPrDeps,
  recorded: readonly RecordedRunPr[] = [],
): Promise<{
  pullRequests: RunWorkPr[];
  complete: boolean;
  warnings: string[];
}> {
  const warnings = new Set<string>();
  const result = new Map<string, RunWorkPr>();
  // Each target carries the repository it reads, because an unlinked
  // receipt's repository is not among `repositories`.
  const targets: {
    checkout: RunCheckout;
    recorded: RecordedRunPr | null;
    repo: ConnectedRunRepository | undefined;
  }[] = [];
  // The receipts go first. A receipt names its pull request outright, and a
  // checkout names only a branch. Each new branch spends one of the 20
  // discoveries, even a default branch that links nothing. With the receipts
  // last, a run with 20 branches in linked repositories never read the PRs
  // its record names.
  for (const receipt of recorded) {
    const repo =
      "repository" in receipt
        ? receipt.repository
        : repositories.find(
            (candidate) =>
              candidate.providerRepositoryId === receipt.repositoryId,
          );
    if (!repo) {
      warnings.add("recorded_repository_not_connected");
      continue;
    }
    targets.push({
      recorded: receipt,
      repo,
      checkout: {
        id: "",
        path: "",
        branch: null,
        headSha: receipt.headSha,
        remoteDigest: null,
        repository: repo,
        firstSeq: "",
        lastSeq: "",
      },
    });
  }
  for (const checkout of checkouts)
    targets.push({
      checkout,
      recorded: null,
      repo: repositories.find(
        (candidate) => candidate.url === checkout.repository?.url,
      ),
    });
  const seenBranches = new Map<string, string[]>();
  const defaultBranches = new Map<string, string>();
  let discoveries = 0;
  for (const { checkout, recorded: receipt, repo } of targets) {
    if (!repo) {
      warnings.add("repository_not_connected");
      continue;
    }
    if (!checkout.branch && !receipt) {
      warnings.add("branch_not_recorded");
      continue;
    }
    const discoveryKey = `${repo.url}:${receipt ? `pr:${receipt.number}` : checkout.branch}`;
    const prior = seenBranches.get(discoveryKey);
    if (prior) {
      for (const key of prior) {
        const pr = result.get(key);
        if (pr && checkout.id && !pr.checkoutIds.includes(checkout.id))
          pr.checkoutIds.push(checkout.id);
      }
      continue;
    }
    if (discoveries++ >= 20) {
      warnings.add("repository_discovery_limit");
      break;
    }
    const discovered: string[] = [];
    seenBranches.set(discoveryKey, discovered);
    try {
      const gh = await deps.client(scope, repo);
      // Every PR opened from a repository's default branch has that branch as
      // its head, so a checkout on `main` matched whatever PR anyone ever
      // opened from `main`, and a session started today showed one from July.
      // A checkout on the default branch or a detached HEAD names no work of
      // its own. Only a recorded receipt links a PR to it.
      if (!receipt && checkout.branch) {
        let defaultBranch = defaultBranches.get(repo.url);
        if (defaultBranch === undefined) {
          defaultBranch = (
            await gh.getRepoInfo({ owner: repo.owner, repo: repo.name })
          ).defaultBranch;
          defaultBranches.set(repo.url, defaultBranch);
        }
        if (checkout.branch === defaultBranch || checkout.branch === "HEAD") {
          warnings.add("default_branch_not_linked");
          continue;
        }
      }
      const prs = receipt
        ? [{ number: receipt.number }]
        : await gh.listPullRequests({
            owner: repo.owner,
            repo: repo.name,
            head: `${repo.owner}:${checkout.branch}`,
            state: "all",
          });
      if (prs.length >= 100) warnings.add("pull_request_list_limit");
      for (const listed of prs) {
        const key = `${repo.url}#${listed.number}`;
        discovered.push(key);
        const found = result.get(key);
        if (found) {
          if (checkout.id && !found.checkoutIds.includes(checkout.id))
            found.checkoutIds.push(checkout.id);
          if (receipt) found.association = "recorded";
          continue;
        }
        if (result.size >= PR_CAP) {
          warnings.add("pull_request_limit");
          break;
        }
        const input = {
          owner: repo.owner,
          repo: repo.name,
          number: listed.number,
        };
        const pr = await gh.getPullRequest(input);
        // What the PR closes is GitHub's own record of it, so it can name the
        // run's task without anything guessed from a branch or a title. A
        // failed read is null and a warning, never an empty list.
        let closingIssues: RunWorkPr["closingIssues"] = null;
        try {
          closingIssues = await gh.listClosingIssues(input);
          if (!closingIssues.complete) warnings.add("closing_issue_limit");
        } catch {
          warnings.add("closing_issues_read_failed");
        }
        let ci: RunWorkPr["ci"] = null;
        let diff: RunWorkPr["diff"] = null;
        let current = false;
        if (pr.headSha) {
          const [checks, files] = await Promise.allSettled([
            gh.listCiChecks({
              owner: repo.owner,
              repo: repo.name,
              ref: pr.headSha,
            }),
            gh.listPullRequestFiles(input),
          ]);
          // The files endpoint is mutable. A moved head invalidates this read.
          const after = await gh.getPullRequest(input);
          current = after.headSha === pr.headSha;
          if (!current) warnings.add("pull_request_head_changed");
          if (checks.status === "fulfilled") {
            const value = checks.value;
            const complete =
              value.complete ??
              (value.checkRuns.length < 100 && value.statuses.length < 100);
            ci = { ...buildCiSummary(value), complete };
            if (!complete) warnings.add("ci_check_limit");
            if (value.sha && value.sha !== pr.headSha) {
              current = false;
              warnings.add("ci_head_mismatch");
            }
          } else warnings.add("ci_read_failed");
          if (files.status === "fulfilled" && current) {
            let remaining = DIFF_BYTES_CAP;
            const limitations: string[] = [];
            const entries = files.value.map((file) => {
              let patch = file.patch;
              if (patch !== null) {
                const size = Buffer.byteLength(patch, "utf8");
                if (size > remaining) {
                  patch = null;
                  limitations.push("diff_size_limit");
                } else remaining -= size;
              } else limitations.push("patch_not_available");
              return {
                path: file.path,
                previousPath: file.previousPath,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                patch,
              };
            });
            if (entries.length < pr.changedFiles || entries.length >= 100)
              limitations.push("diff_file_limit");
            diff = {
              digest: workDigest(
                JSON.stringify([repo.url, pr.number, pr.headSha, entries]),
              ),
              headSha: pr.headSha,
              files: entries,
              complete: limitations.length === 0,
              limitations: [...new Set(limitations)],
            };
          } else if (files.status === "rejected")
            warnings.add("diff_read_failed");
        } else warnings.add("pull_request_head_missing");
        result.set(key, {
          repository: {
            host: repo.host,
            owner: repo.owner,
            name: repo.name,
            url: repo.url,
            // False for a repository the workspace does not link, which a
            // receipt reached through the owner's connection.
            connected: repo.connected,
          },
          number: pr.number,
          title: pr.title,
          url: pr.htmlUrl,
          state: pr.merged ? "merged" : pr.state,
          headSha: pr.headSha,
          headRef: pr.headRef,
          baseRef: pr.baseRef,
          association: receipt
            ? "recorded"
            : checkout.headSha === pr.headSha
              ? "head_commit"
              : "branch",
          closingIssues,
          checkoutIds: checkout.id ? [checkout.id] : [],
          observedAt: deps.now(),
          current,
          ci,
          diff,
        });
      }
    } catch (error) {
      logger.warn(
        { err: error, orgId: scope.orgId, workspaceId: scope.workspaceId },
        "Run pull request evidence could not be read",
      );
      warnings.add("pull_request_read_failed");
    }
  }
  return {
    pullRequests: [...result.values()],
    complete: warnings.size === 0,
    warnings: [...warnings],
  };
}
