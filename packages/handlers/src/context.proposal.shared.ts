// context.proposal.shared.ts — the one place a proposal row is created
// (ADR-061): propose_record and append_record with kind record_proposal both
// land here, so the two entries cannot drift.
import type { CapabilityContext } from "@oxagen/oxagen";
import type {
  ConstraintEffect,
  PublishedSharingScope,
  RecordForce,
  RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import type { ProposalRow, SteeringStore } from "./context.steering.store";

interface CreateProposalInput {
  lineageId: string;
  title?: string;
  label?: string;
  kind: RecordKind;
  force: RecordForce;
  constraintEffect: ConstraintEffect | null;
  sharingScope: PublishedSharingScope;
  statement: string;
  rationale: string;
  source: string | undefined;
  support: {
    runs: string[];
    agents: string[];
    recordIds: string[];
    evidenceLinks: string[];
  };
}

/** Who raised it, when the caller gave no attribution. */
function principalLabel(ctx: CapabilityContext): string {
  if (ctx.userId) return `user:${ctx.userId}`;
  if (ctx.apiKeyId) return `api_key:${ctx.apiKeyId}`;
  return `surface:${ctx.surface}`;
}

/**
 * `createOnly` refuses a lineage that already has a proposal instead of
 * reusing it; a clone must land on a fresh row.
 */
export function createProposal(
  store: Pick<SteeringStore, "insertProposal">,
  ctx: CapabilityContext,
  input: CreateProposalInput,
  options?: { createOnly: boolean },
): Promise<ProposalRow> {
  const values = {
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    lineageId: input.lineageId,
    title: input.title ?? null,
    label: input.label ?? null,
    kind: input.kind,
    force: input.force,
    constraintEffect: input.constraintEffect,
    sharingScope: input.sharingScope,
    statement: input.statement,
    rationale: input.rationale,
    source: input.source ?? principalLabel(ctx),
    supportRuns: input.support.runs,
    supportAgents: input.support.agents,
    supportingRecordIds: input.support.recordIds,
    evidenceLinks: input.support.evidenceLinks,
    createdById: ctx.userId ?? null,
  };
  // One argument when no option is set, so the store sees the call it
  // always saw.
  return options
    ? store.insertProposal(values, options)
    : store.insertProposal(values);
}
