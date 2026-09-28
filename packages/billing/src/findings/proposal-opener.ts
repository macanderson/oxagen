/**
 * proposal-opener.ts — the seam between the findings pass and the code that
 * opens a steering record proposal (detector 6, prompt habits).
 *
 * The proposal path (`createProposal` and the steering store) lives in
 * `@oxagen/handlers`, which depends on this package, so this package cannot
 * import it. The handlers' register module installs the opener when the API
 * process boots, as it does for the memory and Model fit runners. This module
 * imports nothing at run time, so the register module loads it at boot
 * without loading the rest of billing.
 */

/** One steering record proposal for an instruction operators keep repeating. */
export interface InstructionProposal {
  /** The lineage the proposal names: `ctx.habits.instruction-<12 hex>`. */
  lineageId: string;
  /** The repeated sentence, as the earliest run received it. */
  statement: string;
  /** Why the proposal exists, in the finding's own words. */
  rationale: string;
  /** Run public ids that received the sentence, at most 500. */
  runs: string[];
  /** Agent keys among those runs, at most 100. */
  agents: string[];
  /** `frame:<run>/<seq>` for each prompt that carried the sentence, at most 100. */
  evidenceLinks: string[];
}

export interface InstructionProposalScope {
  orgId: string;
  workspaceId: string;
}

/**
 * Open one proposal per entry. An entry whose lineage already has a record
 * or a proposal is left alone, so a later pass never opens it twice and a
 * dismissed proposal stays dismissed.
 */
export type InstructionProposalOpener = (
  scope: InstructionProposalScope,
  proposals: readonly InstructionProposal[],
) => Promise<void>;

let installed: InstructionProposalOpener | null = null;

/** Install the opener. The handlers' register module calls this at boot. */
export function setInstructionProposalOpener(
  opener: InstructionProposalOpener | null,
): void {
  installed = opener;
}

/** The installed opener; null in a process that did not load the handlers. */
export function instructionProposalOpener(): InstructionProposalOpener | null {
  return installed;
}
