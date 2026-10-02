/**
 * open.ts — opens the steering record proposals the builders return.
 *
 * The findings pass in @oxagen/billing calls the opener register.ts
 * installs, which calls `openSpendProposalsFor` inside the workspace's
 * tenant scope. Each proposal goes through `createProposal`, the one place a
 * proposal row is created (ADR-061), with `createOnly` set. A lineage that
 * already has a record or a proposal, in any state, is refused with
 * `clone_name_taken`, and this module leaves it alone. Each builder derives
 * the lineage from what the proposal is about, so a later pass never opens
 * the same proposal twice, a merged one is not proposed again, and a
 * dismissed one stays dismissed.
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
  SpendProposalInput,
  SpendProposalScope,
} from "@oxagen/billing/proposal-opener";
import { emitSecurityEvent } from "@oxagen/database/security";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import { createProposal } from "../../context.proposal.shared";
import {
  postgresSteeringStore,
  type SteeringStore,
} from "../../context.steering.store";
import { proposalSource } from "./shared";
import type { SpendProposal, SpendProposalBuilder } from "./types";

export interface SpendProposalDeps {
  store: Pick<SteeringStore, "insertProposal">;
  create: typeof createProposal;
  audit: typeof emitSecurityEvent;
}

const PRODUCTION_DEPS: SpendProposalDeps = {
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

/** Every builder's proposals for one pass, in builder order. */
export function buildSpendProposals(
  input: SpendProposalInput,
  builders: readonly SpendProposalBuilder[],
): SpendProposal[] {
  return builders.flatMap((builder) => builder.build(input));
}

/**
 * Open one proposal per entry, in order. Each entry is tried even when an
 * earlier one fails. The first failure other than a taken lineage is thrown
 * once every entry has been tried.
 */
export async function openProposals(
  scope: SpendProposalScope,
  proposals: readonly SpendProposal[],
  deps: SpendProposalDeps = PRODUCTION_DEPS,
): Promise<{ opened: number; taken: number }> {
  let opened = 0;
  let taken = 0;
  let failure: { err: unknown } | null = null;
  for (const proposal of proposals) {
    const source = proposalSource(proposal.kind);
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
          source,
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
          ...(proposal.title === null ? {} : { title: proposal.title }),
          kind: "rule",
          force: "should",
          constraintEffect: null,
          sharingScope: "workspace",
          statement: proposal.statement,
          rationale: proposal.rationale,
          source,
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
