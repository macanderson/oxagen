// audit-exempt: a proposal and its steering PR steer nothing until merge_steering_pr publishes the record (MC spec §9.2), and that merge emits steering.published; the kernel's capability.invoke_* audit records the call.
//
// code-repo-check/promote.ts: promote_instruction_to_steering (S7, #4518;
// ADR-263).
//
// A person reads a finding on the Repositories page: a line in a code
// repository's AGENTS.md (or another instruction file) that says the
// opposite of a steering record. Promote makes the line the record. It
// proposes a new version of the contradicted record with the line as its
// text and opens that proposal's steering PR, which runs the six checks.
// Nothing steers until the PR merges.
//
// Flow:
//   1. Read the finding in a repository the workspace links.
//   2. Compare its statement with today's records, as the read does. Only a
//      contradiction promotes: a repeat is in steering already, and a
//      statement that matches nothing has nothing to revise.
//   3. Refuse a finding whose proposal is still open, a statement longer than
//      a record holds, and a record that already has an open PR.
//   4. Propose the new version, record the proposal on the finding, then
//      open its steering PR.
//
// Every refusal comes before the proposal is written. The finding names its
// proposal before the PR opens, so a PR that fails to open leaves a proposal
// a person can open from the Steering page, and a second Promote does not
// propose it twice.
import { HandlerError, type CapabilityContext, type CapabilityHandler } from "@oxagen/oxagen";
import type { SteeringPrOpenOutput } from "@oxagen/oxagen/contracts/steering.pr.open";
import {
  recordKindSchema,
  type ConstraintEffect,
  type ProposalStatus,
  type PublishedSharingScope,
  type RecordForce,
  type RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import type { instructionPromote } from "@oxagen/oxagen/contracts/repository.instruction.promote";
import { createProposal } from "../steering.proposal.shared";
import type { SteeringStore } from "../context.steering.store";
import { effectOfText, type PublishedStatement } from "./findings";
import { compareStored } from "./findings.list";
import { fileLineUrl } from "./run";
import type { CodeRepoFindingStore, FindingScope } from "./store";

/** The longest statement a proposed record holds (proposedRecordSchema). */
export const PROMOTED_STATEMENT_MAX = 2000;

/** No proposal has this id, so the lineage check excludes nothing. */
const NO_PROPOSAL = "00000000-0000-0000-0000-000000000000";

export interface PromoteDeps {
  findings: Pick<CodeRepoFindingStore, "findLinked" | "setProposal">;
  /** The workspace's active steering records. */
  publishedRecords(scope: FindingScope): Promise<PublishedStatement[]>;
  steering: Pick<SteeringStore, "findRecord" | "findOpenPrOnLineage" | "insertProposal">;
  /** open_steering_pr's handler: the steering PR and its six checks. */
  openPr(input: { proposalId: string }, ctx: CapabilityContext): Promise<SteeringPrOpenOutput>;
  /** The handler-side role check (lib/capability-role-guard.ts). */
  assertRole(ctx: CapabilityContext): Promise<void>;
}

function refuse(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/**
 * The kind a proposal for a published record takes, or null for a kind no
 * proposal can revise. A business rule or a code rule is proposed as `rule`,
 * and the steering record keeps the kind its file holds.
 */
export function proposalKindOf(kind: string): RecordKind | null {
  const parsed = recordKindSchema.safeParse(
    kind === "business-rule" || kind === "code-rule" ? "rule" : kind,
  );
  return parsed.success ? parsed.data : null;
}

/** A proposal that is still in flight, so promoting again would make a second one. */
function inFlight(status: string | null): boolean {
  return status !== null && status !== "rejected" && status !== "merged";
}

export function createPromoteInstructionHandler(
  deps: PromoteDeps,
): CapabilityHandler<typeof instructionPromote> {
  return async (input, ctx) => {
    await deps.assertRole(ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const row = await deps.findings.findLinked(scope, input.finding_id);
    if (row === null) {
      throw new HandlerError({
        code: "not_found",
        reason: "finding_not_found",
        message: `No finding ${input.finding_id} in this workspace's linked repositories. Its pull request may have closed, or the repository was unlinked. Load the findings again.`,
      });
    }
    const where = `${row.path} line ${row.line} in ${row.repository}`;

    const [compared] = compareStored([row], await deps.publishedRecords(scope));
    if (compared === undefined) {
      throw refuse(
        "finding_resolved",
        `${where} no longer repeats or contradicts a steering record, so there is nothing to promote.`,
      );
    }
    const name = compared.record.label ?? compared.record.lineage;
    if (compared.kind === "repeat") {
      throw refuse(
        "already_in_steering",
        `${where} says what the steering record ${name} already says. Remove the line from the file instead.`,
      );
    }
    if (row.proposalPublicId !== null && inFlight(row.proposalStatus)) {
      throw refuse(
        "already_proposed",
        `${where} is already proposed as ${row.proposalPublicId}. Open that proposal on the Steering page.`,
      );
    }
    if (row.statement.length > PROMOTED_STATEMENT_MAX) {
      throw refuse(
        "statement_too_long",
        `${where} is ${row.statement.length} characters, and a steering record holds at most ${PROMOTED_STATEMENT_MAX}. Shorten the line, then promote it.`,
      );
    }
    const held = await deps.steering.findRecord(scope, compared.record.lineage);
    if (held === null || !held.record.kind || !held.record.force) {
      throw refuse(
        "finding_resolved",
        `The steering record ${name} is gone or has no kind, so Oxagen cannot propose a new version of it.`,
      );
    }
    const kind = proposalKindOf(held.record.kind);
    if (kind === null) {
      throw refuse(
        "record_not_proposable",
        `The steering record ${name} is a ${held.record.kind}, which a line in an instruction file cannot revise. Edit it in the steering repo instead.`,
      );
    }
    const lineage = compared.record.lineage;
    const open = await deps.steering.findOpenPrOnLineage(scope, lineage, NO_PROPOSAL);
    if (open !== null) {
      throw refuse(
        "lineage_pr_open",
        `${open.prUrl ?? open.publicId} is already open for ${name}. Merge or dismiss it, then promote the line.`,
      );
    }

    const fileUrl = fileLineUrl(
      { provider: row.provider, fullName: row.repository, headSha: row.headSha },
      row,
    );
    const proposal = await createProposal(deps.steering, ctx, {
      lineageId: lineage,
      kind,
      force: held.record.force as RecordForce,
      // A constraint takes its effect from the line's words, as the check read them.
      constraintEffect:
        kind === "constraint" ? (effectOfText(row.statement) as ConstraintEffect) : null,
      sharingScope: held.record.sharingScope as PublishedSharingScope,
      statement: row.statement,
      rationale: `${where} says the opposite of the steering record ${name}. The Oxagen check found it on ${row.pullRequestUrl}. This version makes the line the record.`,
      source: `${row.repository}/${row.path}`.slice(0, 200),
      support: {
        runs: [],
        agents: [],
        recordIds: [],
        evidenceLinks: [row.pullRequestUrl, fileUrl].filter((link) => link.length <= 512),
      },
    });
    await deps.findings.setProposal(scope, row.publicId, proposal.publicId);
    const opened = await deps.openPr({ proposalId: proposal.publicId }, ctx);
    return {
      proposal_id: proposal.publicId,
      lineage,
      status: opened.status as ProposalStatus,
      pull_request:
        opened.pr === null ? null : { number: opened.pr.number, url: opened.pr.url },
    };
  };
}
