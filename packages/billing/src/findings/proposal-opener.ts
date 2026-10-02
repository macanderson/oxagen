/**
 * proposal-opener.ts — the seam between the findings pass and the code that
 * opens steering record proposals from its findings.
 *
 * The pass hands the opener what one pass found: the instructions operators
 * repeat (detector 6) and every finding draft it wrote. The handlers turn
 * that into proposals, with one builder per finding kind
 * (`packages/handlers/src/lib/spend-proposals/`), and open each one.
 *
 * The proposal path (`createProposal` and the steering store) lives in
 * `@oxagen/handlers`, which depends on this package, so this package cannot
 * import it. The handlers' register module installs the opener when the API
 * process boots, as it does for the memory and Model fit runners. This module
 * imports nothing at run time, so the register module loads it at boot
 * without loading the rest of billing.
 */
import type { FindingDraft } from "./shared";

export type { FindingDraft };

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

/** What one findings pass hands the opener. */
export interface SpendProposalInput {
  /**
   * The instructions repeated across runs, most repeated first. Empty on a
   * `digest_only` workspace, because the text is not stored.
   */
  instructions: readonly InstructionProposal[];
  /** The finding drafts the pass wrote, of every kind, largest saving first. */
  findings: readonly FindingDraft[];
}

export interface SpendProposalScope {
  orgId: string;
  workspaceId: string;
}

/**
 * Build the proposals one pass supports and open each one. A proposal whose
 * lineage already has a record or a proposal is left alone, so a later pass
 * never opens it twice and a dismissed proposal stays dismissed.
 */
export type SpendProposalOpener = (
  scope: SpendProposalScope,
  input: SpendProposalInput,
) => Promise<void>;

let installed: SpendProposalOpener | null = null;

/** Install the opener. The handlers' register module calls this at boot. */
export function setSpendProposalOpener(
  opener: SpendProposalOpener | null,
): void {
  installed = opener;
}

/** The installed opener; null in a process that did not load the handlers. */
export function spendProposalOpener(): SpendProposalOpener | null {
  return installed;
}
