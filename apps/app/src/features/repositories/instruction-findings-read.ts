// The instruction-file statements in the workspace's linked code repositories
// that repeat or contradict a steering record, as the Repositories page reads
// them (#4518, ADR-263). The Oxagen check stores each statement it flags on a
// pull request, and `list_code_repository_findings` compares them with
// today's records. This module reads it through the lane's server action and
// keeps what the section draws.
import "server-only";
import type { WsCtx } from "@/server/viewer";
import { listCodeRepositoryFindings } from "./actions";
import type { RepositoriesFailure } from "./failure";
import type { InstructionDriftFinding } from "./instruction-drift";

type CodeRepositoryFindings = {
  /** The workspace's binding of the repository (`rpb_…`). */
  repositoryId: string;
  fullName: string;
  findings: readonly InstructionDriftFinding[];
};

export type CodeRepositoryFindingsRead =
  | { kind: "failed"; failure: RepositoriesFailure }
  | { kind: "ok"; repositories: readonly CodeRepositoryFindings[] };

/** A proposal that is still in flight, so the finding offers no second promote. */
function inFlight(status: string): boolean {
  return status !== "rejected" && status !== "merged";
}

/** The instruction-file findings of the viewer's workspace. */
export async function readCodeRepositoryFindings(
  ctx: WsCtx,
): Promise<CodeRepositoryFindingsRead> {
  const result = await listCodeRepositoryFindings(ctx.orgSlug, ctx.wsSlug);
  if (!result.ok) return { kind: "failed", failure: result };
  return {
    kind: "ok",
    repositories: result.value.repositories.map((repository) => ({
      repositoryId: repository.repository_id,
      fullName: repository.full_name,
      findings: repository.findings.map((finding) => ({
        id: finding.id,
        path: finding.path,
        line: finding.line,
        statement: finding.statement,
        kind: finding.kind,
        record: finding.record.label ?? finding.record.lineage,
        pullRequest: {
          number: finding.pull_request.number,
          url: finding.pull_request.url,
          merged: finding.pull_request.state === "merged",
        },
        proposalId:
          finding.proposal !== null && inFlight(finding.proposal.status)
            ? finding.proposal.id
            : null,
      })),
    })),
  };
}
