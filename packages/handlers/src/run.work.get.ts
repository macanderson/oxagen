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
  connectedRunRepositories,
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
import {
  readLedgerPrReceipts,
  readWorkPullRequests,
  type RecordedRunPr,
} from "./lib/run-work-prs";
import { readWorkReleases } from "./lib/run-work-releases";
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
    const checkouts = contexts
      .slice(0, WORK_CONTEXT_CAP)
      .map((row) => checkoutOf(row, repositories));
    // A PR the harness linked is a receipt: it names the PR outright, so it
    // is read by number and marked `recorded`, and a branch match that finds
    // the same PR merges into it rather than listing it twice.
    const receipts: RecordedRunPr[] = [];
    const linkWarnings = new Set<string>();
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
      if (!repo?.providerRepositoryId) {
        linkWarnings.add("recorded_repository_not_connected");
        continue;
      }
      receipts.push({
        repositoryId: repo.providerRepositoryId,
        number: link.number,
        headSha: null,
      });
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
      diffs: diffs.slice(0, WORK_DIFF_CAP).map(capturedDiffOf),
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
});
