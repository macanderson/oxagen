// audit-exempt: a proposal steers nothing (MC spec §9.2); the kernel capability.invoke_* audit covers it and merge_context_pr emits steering.published at the governance moment.
//
// propose_record (ADR-061): one row in agent.context_proposals, in the
// `proposed` state, for a person to open as a Context PR.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { createProposal } from "./context.proposal.shared";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";

export function createProposeRecordHandler(
  deps: Pick<SteeringDeps, "store">,
): CapabilityHandler<typeof contextProposalCreate> {
  return async (input, ctx) => {
    const row = await createProposal(deps.store, ctx, {
      lineageId: input.record.lineageId,
      kind: input.record.kind,
      force: input.record.force,
      constraintEffect: input.record.constraintEffect ?? null,
      sharingScope: input.record.sharingScope,
      statement: input.record.statement,
      rationale: input.rationale,
      source: input.source,
      support: input.support,
    });
    return {
      proposalId: row.publicId,
      lineageId: row.lineageId,
      status: "proposed",
    };
  };
}

export const proposeRecordHandler = createProposeRecordHandler(steeringDeps());
