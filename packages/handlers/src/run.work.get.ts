import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  runWorkGet,
  type RunWorkGetOutput,
} from "@oxagen/oxagen/contracts/run.work.get";
import {
  defaultRunReadDeps,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";
import {
  capturedDiffOf,
  checkoutOf,
  type ConnectedRunRepository,
  connectedRunRepositories,
  foldProvisionalContexts,
  prLinkOf,
  readWorkPrLinks,
  readWorkContexts,
  readWorkDiffs,
  readWorkSubagents,
  subagentOf,
  WORK_CONTEXT_CAP,
  WORK_DIFF_CAP,
  WORK_PR_LINK_CAP,
  WORK_SUBAGENT_CAP,
} from "./lib/run-work";
import { readRunCommandRefFrames } from "./lib/run-command-refs";
import { githubConnectionFor } from "./lib/run-pull-request-backfill";
import {
  readLedgerPrReceipts,
  readWorkPullRequests,
  type RecordedRunPr,
} from "./lib/run-work-prs";
import { readWorkReleases } from "./lib/run-work-releases";
import { logger } from "./logger";
import { runScope } from "./run.list";

export type RunWorkDeps = RunReadDeps & {
  contexts: typeof readWorkContexts;
  diffs: typeof readWorkDiffs;
  subagents: typeof readWorkSubagents;
  prLinks: typeof readWorkPrLinks;
  repositories: typeof connectedRunRepositories;
  pullRequests: typeof readWorkPullRequests;
  /** The command and network frames that could name a release (#3890). */
  commandFrames: typeof readRunCommandRefFrames;
  /** The releases those frames created, with GitHub's state for each. */
  releases: typeof readWorkReleases;
  /**
   * The id of the workspace's own GitHub connection that reads an owner's
   * repositories, or null when none does. A PR the run's record names in a
   * repository the workspace does not link is read through it, as the
   * ADR-192 backfill reads that PR's state.
   */
  githubConnection: typeof githubConnectionFor;
};
export function createRunWorkGetHandler(
  deps: RunWorkDeps,
): CapabilityHandler<typeof runWorkGet> {
  return async (input, ctx): Promise<RunWorkGetOutput> => {
    const userId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId },
      { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
    );
    const scope = runScope(ctx);
    const run = await resolveRun(deps, ctx, input.runId);
    if (run.source !== "tacho") {
      const ledger = await readLedgerPrReceipts(deps.store, run.runId);
      const repositories = await deps.repositories(scope);
      const prs = await deps.pullRequests(
        scope,
        [],
        repositories,
        undefined,
        ledger.receipts,
      );
      return {
        runId: input.runId,
        machine: null,
        checkouts: [],
        diffs: [],
        pullRequests: prs.pullRequests,
        subagents: [],
        // A ledger run records no shell commands, so it records no release
        // (#3890).
        releases: [],
        complete: false,
        warnings: [
          "checkout_context_not_recorded",
          ...prs.warnings,
          ...(ledger.complete ? [] : ["ledger_event_limit"]),
        ],
      };
    }
    const [contexts, diffs, subagents, links, repositories, frames] =
      await Promise.all([
        deps.contexts(run.sessionUuid),
        deps.diffs(run.sessionUuid),
        deps.subagents(run.sessionUuid),
        deps.prLinks(run.sessionUuid),
        deps.repositories(scope),
        deps.commandFrames(run.sessionUuid),
      ]);
    // A session's first hook is sealed before its first Git read, so it names
    // a path and nothing else. It folds into the Git context read at the
    // same path, rather than standing as a checkout no repository or branch
    // can match, which kept the work incomplete for good (#3791).
    const located = foldProvisionalContexts(contexts);
    const checkouts = located.rows
      .slice(0, WORK_CONTEXT_CAP)
      .map((row) => checkoutOf(row, repositories));
    // A PR the harness linked is a receipt: it names the PR outright, so it
    // is read by number and marked `recorded`, and a branch match that finds
    // the same PR merges into it rather than listing it twice.
    const receipts: RecordedRunPr[] = [];
    const linkWarnings = new Set<string>();
    // A run's record can name a PR in a repository the workspace does not
    // link, when the agent worked in a repository another workspace links.
    // The link is still certain, so that PR is read through the workspace's
    // own GitHub connection for its owner, the one the ADR-192 backfill reads
    // its state with. Before #5296 every such link was dropped, and the
    // section said "No pull request" for a run that opened several. Each
    // owner is looked up once, and each repository is built once.
    const owners = new Map<string, Promise<string | null | undefined>>();
    const unlinked = new Map<string, ConnectedRunRepository>();
    const connectionFor = (owner: string) => {
      let found = owners.get(owner);
      if (found === undefined) {
        // Undefined means the lookup failed, which is a failed read and not
        // a repository no connection reaches.
        found = deps.githubConnection(scope, owner).catch((err: unknown) => {
          logger.warn(
            { err, orgId: scope.orgId, workspaceId: scope.workspaceId },
            "get_run_work: the GitHub connection for a recorded pull request could not be read",
          );
          linkWarnings.add("pull_request_read_failed");
          return undefined;
        });
        owners.set(owner, found);
      }
      return found;
    };
    for (const row of links.slice(0, WORK_PR_LINK_CAP)) {
      const link = prLinkOf(row);
      if (link === null) {
        linkWarnings.add("pr_link_unreadable");
        continue;
      }
      const repo = repositories.find(
        (candidate) =>
          candidate.owner.toLowerCase() === link.owner.toLowerCase() &&
          candidate.name.toLowerCase() === link.name.toLowerCase(),
      );
      if (repo?.providerRepositoryId) {
        receipts.push({
          repositoryId: repo.providerRepositoryId,
          number: link.number,
          headSha: null,
        });
        continue;
      }
      // Only a github.com link goes to a GitHub connection. A GitLab owner
      // can share a GitHub owner's name.
      if (repo === undefined && new URL(link.url).hostname === "github.com") {
        const connectionId = await connectionFor(link.owner.toLowerCase());
        if (connectionId === undefined) continue;
        if (connectionId !== null) {
          const key = `${link.owner}/${link.name}`.toLowerCase();
          let other = unlinked.get(key);
          if (other === undefined) {
            other = {
              connectionId,
              host: "github.com",
              owner: link.owner,
              name: link.name,
              url: `https://github.com/${link.owner}/${link.name}`,
              connected: false,
            };
            unlinked.set(key, other);
          }
          receipts.push({
            repository: other,
            number: link.number,
            headSha: null,
          });
          continue;
        }
      }
      linkWarnings.add("recorded_repository_not_connected");
    }
    // The pull requests and the releases are separate GitHub reads, so they
    // run side by side.
    const [prs, releases] = await Promise.all([
      deps.pullRequests(scope, checkouts, repositories, undefined, receipts),
      deps.releases(scope, frames, checkouts, repositories),
    ]);
    const warnings = [
      ...new Set([...prs.warnings, ...linkWarnings, ...releases.warnings]),
    ];
    if (links.length > WORK_PR_LINK_CAP) warnings.push("pr_link_limit");
    // Read before the fold: a query that hit its limit may have cut rows,
    // whatever the fold leaves.
    if (contexts.length > WORK_CONTEXT_CAP) warnings.push("checkout_limit");
    if (diffs.length > WORK_DIFF_CAP) warnings.push("captured_diff_limit");
    if (subagents.length > WORK_SUBAGENT_CAP) warnings.push("subagent_limit");
    if (!contexts.length) warnings.push("checkout_context_not_recorded");
    // The facts above come from every frame the host sent, including frames
    // past a chain break. The break is reported here rather than by dropping
    // them, so the page shows what the store holds and says what the chain
    // cannot prove (ADR-171).
    if (run.row.session.chainVerified === false) warnings.push("chain_break");
    return {
      runId: input.runId,
      machine: run.row.host?.hostname ? { name: run.row.host.hostname } : null,
      checkouts,
      diffs: diffs.slice(0, WORK_DIFF_CAP).map((row) => {
        const diff = capturedDiffOf(row);
        const folded = located.alias.get(diff.checkoutId);
        return folded === undefined ? diff : { ...diff, checkoutId: folded };
      }),
      pullRequests: prs.pullRequests,
      subagents: subagents.slice(0, WORK_SUBAGENT_CAP).map(subagentOf),
      releases: releases.releases,
      complete: warnings.length === 0,
      warnings,
    };
  };
}
export const runWorkGetHandler = createRunWorkGetHandler({
  ...defaultRunReadDeps(),
  contexts: readWorkContexts,
  diffs: readWorkDiffs,
  subagents: readWorkSubagents,
  prLinks: readWorkPrLinks,
  repositories: connectedRunRepositories,
  pullRequests: readWorkPullRequests,
  commandFrames: readRunCommandRefFrames,
  releases: readWorkReleases,
  githubConnection: githubConnectionFor,
});
