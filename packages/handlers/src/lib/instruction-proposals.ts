/**
 * instruction-proposals.ts — opens a steering record proposal for each
 * instruction operators repeat across runs (detector 6, prompt habits).
 *
 * The findings pass in @oxagen/billing finds the instructions and calls the
 * opener register.ts installs, which calls this module inside the
 * workspace's tenant scope. Each proposal goes through `createProposal`, the
 * one place a proposal row is created (ADR-061), with `createOnly` set. A
 * lineage that already has a record or a proposal is refused with
 * `clone_name_taken`, and this module leaves it alone: a later pass never
 * opens the same instruction twice, and a dismissed proposal stays dismissed.
 */
import { randomUUID } from "node:crypto";
import type {
  InstructionProposal,
  InstructionProposalScope,
} from "@oxagen/billing/proposal-opener";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { createProposal } from "../context.proposal.shared";
import {
  postgresSteeringStore,
  type SteeringStore,
} from "../context.steering.store";

/** The attribution each proposal carries. */
export const INSTRUCTION_PROPOSAL_SOURCE = "finding:repeated_instructions";

export interface InstructionProposalDeps {
  store: Pick<SteeringStore, "insertProposal">;
  create: typeof createProposal;
}

const PRODUCTION_DEPS: InstructionProposalDeps = {
  store: postgresSteeringStore,
  create: createProposal,
};

/** True when the lineage already has a record or a proposal. */
function isTaken(err: unknown): boolean {
  return (
    isHandlerError(err) &&
    err.code === "conflict" &&
    err.reason === "clone_name_taken"
  );
}

/**
 * Open one proposal per entry, in order. Each entry is tried even when an
 * earlier one fails. The first failure other than a taken lineage is thrown
 * once every entry has been tried.
 */
export async function openInstructionProposalsFor(
  scope: InstructionProposalScope,
  proposals: readonly InstructionProposal[],
  deps: InstructionProposalDeps = PRODUCTION_DEPS,
): Promise<{ opened: number; taken: number }> {
  let opened = 0;
  let taken = 0;
  let failure: { err: unknown } | null = null;
  for (const proposal of proposals) {
    const ctx: CapabilityContext = {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      userId: null,
      apiKeyId: null,
      requestId: randomUUID(),
      surface: "runner",
      messageId: null,
    };
    try {
      await deps.create(
        deps.store,
        ctx,
        {
          lineageId: proposal.lineageId,
          kind: "rule",
          force: "should",
          constraintEffect: null,
          sharingScope: "workspace",
          statement: proposal.statement,
          rationale: proposal.rationale,
          source: INSTRUCTION_PROPOSAL_SOURCE,
          support: {
            runs: proposal.runs,
            agents: proposal.agents,
            recordIds: [],
            evidenceLinks: proposal.evidenceLinks,
          },
        },
        { createOnly: true },
      );
      opened += 1;
    } catch (err) {
      if (isTaken(err)) taken += 1;
      else failure ??= { err };
    }
  }
  if (failure !== null) throw failure.err;
  return { opened, taken };
}
