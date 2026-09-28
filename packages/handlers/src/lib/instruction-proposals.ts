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
 *
 * This is the system path to `propose_record`. The findings job has no acting
 * user, so the handler's role check (`assertOrgRole`) has no one to check and
 * the kernel writes no `capability.invoke_*` row. Its authority is fixed here
 * instead: one workspace, a `should` rule shared with that workspace, and a
 * new lineage only. The proposal steers nothing until a person with a
 * workspace role merges it as a Context PR, and `merge_context_pr` checks that
 * role. Each write records the audit row the kernel would have written, with
 * a null actor and `findings_job` in its detail.
 */
import { randomUUID } from "node:crypto";
import type {
  InstructionProposal,
  InstructionProposalScope,
} from "@oxagen/billing/proposal-opener";
import { emitSecurityEvent } from "@oxagen/database/security";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
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
  audit: typeof emitSecurityEvent;
}

const PRODUCTION_DEPS: InstructionProposalDeps = {
  store: postgresSteeringStore,
  create: createProposal,
  audit: emitSecurityEvent,
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
    const audit = (proposalId: string | null) =>
      deps.audit({
        eventType:
          proposalId === null
            ? "capability.invoke_error"
            : "capability.invoke_allowed",
        actorUserId: null,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        capability: contextProposalCreate.name,
        outcome: proposalId === null ? "error" : "allow",
        ip: null,
        userAgent: null,
        requestId: ctx.requestId,
        detail: {
          actor: "findings_job",
          source: INSTRUCTION_PROPOSAL_SOURCE,
          lineageId: proposal.lineageId,
          proposalId,
        },
      });
    try {
      const row = await deps.create(
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
      audit(row.publicId);
    } catch (err) {
      // A taken lineage wrote nothing and decided nothing, so it leaves no
      // audit row. Every later pass is refused the same way.
      if (isTaken(err)) taken += 1;
      else {
        failure ??= { err };
        audit(null);
      }
    }
  }
  if (failure !== null) throw failure.err;
  return { opened, taken };
}
