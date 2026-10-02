/**
 * open-proposals.ts — the findings pass's call into the steering record
 * proposal opener the handlers install (./proposal-opener.ts).
 *
 * A pass in a process without the handlers, or a failed open, writes its
 * findings all the same: the next pass hands the opener the same material,
 * and a lineage that already has a proposal is left alone.
 */
import { logger } from "../logger";
import {
  spendProposalOpener,
  type SpendProposalInput,
  type SpendProposalScope,
} from "./proposal-opener";

/**
 * Hand one pass's repeated instructions and finding drafts to the installed
 * opener. A pass with neither has nothing to propose. A pass with findings
 * and no instructions still calls the opener, so a `digest_only` workspace
 * gets the proposals its findings support.
 */
export async function openSpendProposals(
  scope: SpendProposalScope,
  input: SpendProposalInput,
): Promise<void> {
  if (input.instructions.length === 0 && input.findings.length === 0) return;
  const counts = {
    instructions: input.instructions.length,
    findings: input.findings.length,
  };
  const open = spendProposalOpener();
  if (open === null) {
    logger.warn(
      { ...scope, ...counts },
      "findings: no steering record proposal opener installed",
    );
    return;
  }
  try {
    await open(scope, input);
  } catch (err) {
    logger.error(
      { ...scope, ...counts, err },
      "findings: opening steering record proposals failed",
    );
  }
}
