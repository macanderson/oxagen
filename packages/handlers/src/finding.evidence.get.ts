// audit-exempt: read-only — answers one finding's evidence from cost.findings; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_finding_evidence` (ADR-062): the arithmetic the findings job wrote
// with the finding, as the contract's money shapes.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  findingEvidenceGet,
  type FindingEvidenceGetOutput,
} from "@oxagen/oxagen/contracts/finding.evidence.get";
import {
  findingNotFound,
  findingScope,
  readFindingRow,
  toEvidence,
  toFinding,
} from "./finding.shared";

type FindingEvidenceDeps = { read: typeof readFindingRow };

export function createFindingEvidenceHandler(
  deps: FindingEvidenceDeps,
): CapabilityHandler<typeof findingEvidenceGet> {
  return async (input, ctx): Promise<FindingEvidenceGetOutput> => {
    const row = await deps.read(findingScope(ctx), input.findingId);
    if (!row) throw findingNotFound();
    return { finding: toFinding(row), evidence: toEvidence(row) };
  };
}

export const findingEvidenceHandler = createFindingEvidenceHandler({
  read: readFindingRow,
});
