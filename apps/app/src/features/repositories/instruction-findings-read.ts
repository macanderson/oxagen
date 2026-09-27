// The instruction files that drifted in the workspace's code repositories, as
// the Repositories page reads them (#4518). No capability answers the read
// yet, so it makes no kernel call: an unregistered name reports to error
// tracking on every page view. It answers `not_backed` and names the
// capability instead.
//
// `list_code_repository_findings` takes `{}` in the workspace scope and
// returns one entry per linked code repository:
//   repositoryId  the repository binding's id, which Promote to steering sends
//   fullName      owner/name on the host
//   findings      [{ path }], each instruction file whose content differs
//                 from the steering records
import "server-only";
import type { WsCtx } from "@/server/viewer";
import type { InstructionDriftFinding } from "./instruction-drift";

type CodeRepositoryFindings = {
  repositoryId: string;
  fullName: string;
  findings: readonly InstructionDriftFinding[];
};

export type CodeRepositoryFindingsRead =
  | { kind: "not_backed"; capability: string }
  | { kind: "ok"; repositories: readonly CodeRepositoryFindings[] };

const FINDINGS_CAPABILITY = "list_code_repository_findings";

/** The drifted instruction files of the viewer's workspace. It stays a promise so callers keep their shape once the capability exists. */
export function readCodeRepositoryFindings(
  _ctx: WsCtx,
): Promise<CodeRepositoryFindingsRead> {
  return Promise.resolve({
    kind: "not_backed",
    capability: FINDINGS_CAPABILITY,
  });
}
