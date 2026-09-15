// audit-exempt: an agent's append is memory, covered by the kernel capability.invoke_* audit; the governance moment is merge_context_pr, which emits steering.published.
//
// append_record (ADR-061; MC spec §9): content-addressed by the record_hash
// Stella computes, idempotent per workspace, and refusing a directive — that
// reaches the workspace only through a Context PR. A signed-in caller holds
// one of the contract's roles (§3.2, INV-29); a call with no user is an API
// key, which the kernel authorizes.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextRecordsAppend } from "@oxagen/oxagen/contracts/context.records.append";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { AppendKind } from "@oxagen/oxagen/contracts/context.steering.shared";
import { recordHash } from "@oxagen/run-evidence";
import { createProposal } from "./context.proposal.shared";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";

export function createAppendRecordHandler(
  deps: Pick<SteeringDeps, "store">,
): CapabilityHandler<typeof contextRecordsAppend> {
  return async (input, ctx) => {
    if (ctx.userId) {
      await assertOrgRole(
        { ...ctx, userId: await resolveActingUserId(ctx) },
        { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
      );
    }
    if (input.kind === "directive") {
      throw new HandlerError({
        code: "conflict",
        reason: "directive_requires_context_pr",
        message:
          "An agent may only propose a directive; it becomes active through a Context PR (MC spec §9, §10)",
      });
    }
    const kind: AppendKind = input.kind;
    if (kind === "record_proposal" && !input.proposal) {
      throw new HandlerError({
        code: "conflict",
        reason: "proposal_fields_required",
        message:
          "A record_proposal names the kind, force and rationale it proposes",
      });
    }
    if (kind !== "record_proposal" && input.proposal) {
      throw new HandlerError({
        code: "conflict",
        reason: "proposal_fields_refused",
        message: `A ${kind} carries no proposal; use kind record_proposal`,
      });
    }
    const proposal = input.proposal;
    if (
      proposal &&
      (proposal.kind === "constraint") !==
        (proposal.constraintEffect !== undefined)
    ) {
      throw new HandlerError({
        code: "conflict",
        reason: "constraint_effect_mismatch",
        message:
          "A constraint declares require or forbid; no other kind carries an effect",
      });
    }

    const hash = recordHash({
      kind,
      lineage_id: input.lineageId,
      statement: input.statement,
      sharing_scope: input.sharingScope,
      source_refs: input.sourceRefs,
      evidence_links: input.evidenceLinks,
      ...(proposal
        ? {
            proposal: {
              kind: proposal.kind,
              force: proposal.force,
              constraint_effect: proposal.constraintEffect ?? null,
              rationale: proposal.rationale,
            },
          }
        : {}),
    });

    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const existing = await deps.store.findAppendByHash(scope, hash);
    if (existing) {
      const first = existing.proposalId
        ? await deps.store.findProposalById(existing.proposalId)
        : null;
      return {
        recordId: existing.publicId,
        recordHash: existing.recordHash,
        kind: existing.kind as AppendKind,
        appended: false,
        proposalId: first?.publicId ?? null,
      };
    }

    const proposalRow =
      proposal && kind === "record_proposal"
        ? await createProposal(deps.store, ctx, {
            lineageId: input.lineageId,
            kind: proposal.kind,
            force: proposal.force,
            constraintEffect: proposal.constraintEffect ?? null,
            sharingScope: input.sharingScope,
            statement: input.statement,
            rationale: proposal.rationale,
            source: undefined,
            support: {
              runs: [],
              agents: [],
              recordIds: [],
              evidenceLinks: input.evidenceLinks,
            },
          })
        : null;

    const { row, appended } = await deps.store.insertAppend({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      kind,
      lineageId: input.lineageId,
      statement: input.statement,
      sharingScope: input.sharingScope,
      recordHash: hash,
      sourceRefs: input.sourceRefs,
      evidenceLinks: input.evidenceLinks,
      proposalId: proposalRow?.id ?? null,
      createdByUserId: ctx.userId ?? null,
    });

    let proposalPublicId = proposalRow?.publicId ?? null;
    if (!appended) {
      // Two identical appends raced past the lookup above; the unique
      // (workspace, record_hash) index kept the first. Its proposal is the
      // one that counts, and the row created for this repeat is dismissed.
      if (proposalRow) {
        await deps.store.updateProposal(
          proposalRow.id,
          {
            status: "rejected",
            dismissedAt: new Date(),
            dismissedReason: `duplicate of the append ${row.publicId}`,
          },
          ["proposed"],
        );
      }
      const first = row.proposalId
        ? await deps.store.findProposalById(row.proposalId)
        : null;
      proposalPublicId = first?.publicId ?? null;
    }

    return {
      recordId: row.publicId,
      recordHash: row.recordHash,
      kind: row.kind as AppendKind,
      appended,
      proposalId: proposalPublicId,
    };
  };
}

export const appendRecordHandler = createAppendRecordHandler(steeringDeps());
