// audit-exempt: a proposal steers nothing (MC spec §9.2); the kernel capability.invoke_* audit covers it and merge_context_pr emits steering.published at the governance moment.
//
// propose_record (ADR-061): one row in agent.context_proposals, in the
// `proposed` state, for a person to open as a Context PR. The acting user —
// the signed-in user, or the creator of the API key (resolveActingUserId) —
// holds one of the contract's roles (§3.2, INV-29). The row's author stays
// the signed-in user, null for a key, so the Context PR stamps an agent's
// proposal `inferred`.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { createProposal } from "./context.proposal.shared";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";

export function createProposeRecordHandler(
  deps: Pick<SteeringDeps, "store"> & {
    /**
     * Refuse a lineage that already has a record or a proposal, whatever the
     * caller asks (a clone's row is new by definition). A caller can also ask
     * for it per call with `createOnly` on the input.
     */
    createOnly?: boolean;
  },
): CapabilityHandler<typeof contextProposalCreate> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
    );
    const row = await createProposal(
      deps.store,
      ctx,
      {
        lineageId: input.record.lineageId,
        title: input.record.title,
        label: input.record.label,
        kind: input.record.kind,
        force: input.record.force,
        constraintEffect: input.record.constraintEffect ?? null,
        sharingScope: input.record.sharingScope,
        statement: input.record.statement,
        rationale: input.rationale,
        source: input.source,
        support: input.support,
      },
      deps.createOnly === true || input.createOnly === true
        ? { createOnly: true }
        : undefined,
    );
    return {
      proposalId: row.publicId,
      lineageId: row.lineageId,
      status: "proposed",
    };
  };
}

export const proposeRecordHandler = createProposeRecordHandler(steeringDeps());
