// audit-exempt: read-only — reads a Context PR's files from the repository host; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// get_context_pr_diff (ADR-061; ADR-184): what a Context PR changes, read
// from the host now. The paths come from the host's compare of the pull
// request's head against the production branch, and each path is read on
// both sides, so the page draws the diff from the two texts it would merge.
// Nothing here is stored: the branch is the truth until it merges.
//
// A merged or closed Context PR has its branch deleted (merge_context_pr,
// dismiss_proposal and the repository sync each delete it), so there is no
// head to read and the answer is `settled` with no files.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  CONTEXT_PR_DIFF_MAX_CHARS,
  CONTEXT_PR_DIFF_MAX_FILES,
  contextPrDiffGet,
} from "@oxagen/oxagen/contracts/context.pr.diff.get";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import { assertSameHost } from "./context.steering.github";

/** A side's text, cut at the cap. */
function capped(text: string | null): { text: string | null; cut: boolean } {
  if (text === null || text.length <= CONTEXT_PR_DIFF_MAX_CHARS)
    return { text, cut: false };
  return { text: text.slice(0, CONTEXT_PR_DIFF_MAX_CHARS), cut: true };
}

export function createGetContextPrDiffHandler(
  deps: Pick<SteeringDeps, "store" | "github">,
): CapabilityHandler<typeof contextPrDiffGet> {
  return async (input, ctx) => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const row = await deps.store.findProposal(scope, input.proposalId);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "proposal_not_found",
        message: `No proposal ${input.proposalId} in this workspace`,
      });
    }
    const empty = (state: "no_pr" | "settled") => ({
      proposalId: row.publicId,
      state,
      baseRef: row.baseRef,
      headSha: row.headSha,
      files: [],
      moreFiles: false,
    });
    if (row.prNumber === null || !row.branch) return empty("no_pr");
    if (row.status === "merged" || row.status === "rejected")
      return empty("settled");

    const repo = await deps.github.resolveRepository(scope);
    assertSameHost(repo, row.provider, row.prUrl);
    // The head as the host has it now, so a push after the checks ran shows.
    const head = await deps.github.branchHead(repo, row.branch);
    if (head === null) return empty("settled");
    const base = row.baseRef ?? repo.defaultBranch;
    const changed = await deps.github.changedFiles(repo, base, head);
    const shown = changed.slice(0, CONTEXT_PR_DIFF_MAX_FILES);
    const files = await Promise.all(
      shown.map(async (file) => {
        const [before, after] = await Promise.all([
          file.status === "added"
            ? null
            : deps.github.readFile(repo, file.path, base),
          file.status === "removed"
            ? null
            : deps.github.readFile(repo, file.path, head),
        ]);
        const b = capped(before);
        const a = capped(after);
        return {
          path: file.path,
          status: file.status,
          before: b.text,
          after: a.text,
          truncated: b.cut || a.cut,
        };
      }),
    );
    return {
      proposalId: row.publicId,
      state: "diff" as const,
      baseRef: base,
      headSha: head,
      files,
      moreFiles: changed.length > shown.length,
    };
  };
}

export const getContextPrDiffHandler = createGetContextPrDiffHandler(
  steeringDeps(),
);
