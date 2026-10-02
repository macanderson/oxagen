/**
 * repeated-instructions.ts — the proposal builder for detector 6, prompt
 * habits.
 *
 * The detector in @oxagen/billing writes each proposal already
 * (`instructionProposals`): one per instruction operators repeat across
 * runs, on a `content_exact` workspace only. This builder passes each one on
 * as it is. The record keeps no title, so it is named by the repeated
 * sentence.
 */
import type { SpendProposalBuilder } from "./types";

export const repeatedInstructionProposals: SpendProposalBuilder = {
  kind: "repeated_instructions",
  build: (input) =>
    input.instructions.map((instruction) => ({
      kind: "repeated_instructions",
      lineageId: instruction.lineageId,
      title: null,
      statement: instruction.statement,
      rationale: instruction.rationale,
      runs: instruction.runs,
      agents: instruction.agents,
      evidenceLinks: instruction.evidenceLinks,
    })),
};
