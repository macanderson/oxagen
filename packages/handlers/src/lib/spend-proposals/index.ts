/**
 * spend-proposals — steering record proposals from the findings pass.
 *
 * Each finding kind that supports a proposal has one builder in this
 * directory. A builder reads its kind out of the pass's input and returns the
 * record text, its title, and its evidence: the runs and the figures. A new
 * builder goes in its own module and takes one line in
 * `SPEND_PROPOSAL_BUILDERS`.
 */
import type {
  SpendProposalInput,
  SpendProposalScope,
} from "@oxagen/billing/proposal-opener";
import {
  buildSpendProposals,
  openProposals,
  type SpendProposalDeps,
} from "./open";
import { repeatedInstructionProposals } from "./repeated-instructions";
import { spinLoopProposals } from "./spin-loops";
import type { SpendProposalBuilder } from "./types";

/** Every builder a pass runs, in the order its proposals open. */
export const SPEND_PROPOSAL_BUILDERS: readonly SpendProposalBuilder[] = [
  repeatedInstructionProposals,
  spinLoopProposals,
];

/** Build every proposal one pass supports and open each one. */
export function openSpendProposalsFor(
  scope: SpendProposalScope,
  input: SpendProposalInput,
  deps?: SpendProposalDeps,
): Promise<{ opened: number; taken: number }> {
  return openProposals(
    scope,
    buildSpendProposals(input, SPEND_PROPOSAL_BUILDERS),
    deps,
  );
}
