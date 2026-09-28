// audit-exempt: read-only — answers one finding's evidence from cost.findings; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_finding_evidence` (ADR-062): the arithmetic the findings job wrote
// with the finding, as the contract's money shapes.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  findingEvidenceGet,
  type FindingEvidenceGetOutput,
} from "@oxagen/oxagen/contracts/finding.evidence.get";
import { readRunNames } from "./lib/run-names";
import {
  evidenceRunIds,
  findingNotFound,
  findingScope,
  readFindingRow,
  toEvidence,
  toFinding,
} from "./finding.shared";

type FindingEvidenceDeps = {
  read: typeof readFindingRow;
  /** The session name of each cited run, so the page names it (#4571). */
  readRunNames: typeof readRunNames;
};

export function createFindingEvidenceHandler(
  deps: FindingEvidenceDeps,
): CapabilityHandler<typeof findingEvidenceGet> {
  return async (input, ctx): Promise<FindingEvidenceGetOutput> => {
    const scope = findingScope(ctx);
    const row = await deps.read(scope, input.findingId);
    if (!row) throw findingNotFound();
    const names = await deps.readRunNames(scope, evidenceRunIds(row));
    return { finding: toFinding(row), evidence: toEvidence(row, names) };
  };
}

export const findingEvidenceHandler = createFindingEvidenceHandler({
  read: readFindingRow,
  readRunNames,
});
