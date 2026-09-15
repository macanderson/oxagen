// Column-level mappers for the approvals queue.
// Pure: rows in, view-model candidates out. The live adapter
// (../approvals.ts) reads the rows inside tenant scope and parses what these
// return through the view-model schemas, so a mapper cannot lie about a shape.
//
// agent.approval_requests → ApprovalItem (plan §3.1 "Fleet · approvals panel")
//
//   public_id            → id                  recorded, BUT not the key the decision writes use.
//                                              resolve_approval (packages/agent/src/handlers/
//                                              agent.approval.resolve.ts) and mcp_consent.resolve
//                                              match `approval_requests.id` (the uuid), and the
//                                              runtime's waitForApproval/pg_notify key on the uuid
//                                              too. Passing this `apr_…` id to either resolve
//                                              handler makes Postgres fail with `invalid input
//                                              syntax for type uuid`. The read is recorded; the
//                                              decision is 🟡 until the handlers accept the public
//                                              id (see "Promote" item 1 in the PR). The row uuid
//                                              is deliberately not exposed: view-model ids are
//                                              public ids.
//   workspace_id         → workspaceSlug       recorded (workspace.workspaces.slug)
//   resolution, expires_at → status           recorded: null + future expiry = pending,
//                                              null + past expiry = expired (waitForApproval
//                                              times out without writing a resolution)
//   risk_level           → risk                recorded (CHECK low|medium|high|critical)
//   created_at           → requestedAt         recorded
//   expires_at           → expiresAt           recorded
//   capability_name      → chain.action        NOT a ToolVersionRef: no version is recorded,
//                                              and names carry dots (`budget.turn.continue`)
//   —                    → runId               NOT recorded: execution_step_id and
//                                              tool_call_id are never written, and
//                                              iam.authorization_decisions.approval_request_id
//                                              is always NULL (packages/iam live-agent-run-authorization)
//   —                    → chain.operatorId    NOT recorded on the row (derivable only through
//                                              message_id → chat.messages → chat.conversations.user_id)
//   —                    → chain.agentKey      NOT recorded
//   —                    → chain.trigger, rules, mandateId  NOT recorded (G1, G2)
//   —                    → sideEffect, egress, tier, tainted, taintSources  NOT recorded
//   —                    → inputDigest         NOT recorded (input_preview is stored, not its
//                                              canonical digest; previews may carry floats,
//                                              which the repo's JCS digests refuse)
//   —                    → amount, counterparty, policyVersionId  NOT recorded
//   —                    → approvers           NOT recorded (resolve_approval's IAM decides who
//                                              may resolve; no approver set is stored per request)
//   input_preview, message_id, note, resolved_*  not in the view model
//
// Every NOT-recorded field is null in the candidate, never a guessed value. The
// view model (src/data/contracts/approvals.ts) requires several of them, so
// today a real row does not parse and the adapter reports the queue as not
// backed rather than hiding a pending approval behind an empty list.
//
import type { schema } from "@oxagen/database";
import {
  type ApprovalItem,
  type ApprovalStatus,
  PublicId,
  Risk,
  Slug,
} from "@/data/contracts";

export type ApprovalRequestRow = typeof schema.approvalRequests.$inferSelect;

type Nullable<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] | null };

/**
 * An approval as the store records it: the ApprovalItem shape with every field
 * the store does not record set to null. `capabilityName` is carried beside
 * the null `chain.action` because the store records the name but not the
 * version a ToolVersionRef needs (see "promote" in the PR).
 */
export type ApprovalCandidate = Nullable<
  Omit<ApprovalItem, "chain">,
  "runId" | "sideEffect" | "egress" | "tier" | "inputDigest" | "approvers"
> & {
  chain: Nullable<ApprovalItem["chain"], "operatorId" | "agentKey" | "action">;
  capabilityName: string;
};

/**
 * The ApprovalItem paths no approval_requests row records today. A candidate
 * that fails the view model on exactly these paths is a store gap, not a
 * mapping bug.
 */
export const UNRECORDED_APPROVAL_PATHS = [
  "runId",
  "chain.operatorId",
  "chain.agentKey",
  "chain.action",
  "sideEffect",
  "egress",
  "tier",
  "inputDigest",
  "approvers",
] as const;

/** How long an approval that expired unresolved stays in the queue ("recently expired"). */
export const RECENTLY_EXPIRED_MS = 15 * 60 * 1000;

export function approvalStatus(
  row: Pick<ApprovalRequestRow, "resolution" | "expiresAt">,
  now: Date,
): ApprovalStatus {
  switch (row.resolution) {
    case null:
      return row.expiresAt.getTime() > now.getTime() ? "pending" : "expired";
    case "approved":
    case "denied":
    case "expired":
      return row.resolution;
    default:
      // The table's CHECK allows nothing else; drift is a mapping error, not a status.
      throw new ApprovalMappingError("resolution", row.resolution);
  }
}

export function toApprovalCandidate(
  row: ApprovalRequestRow,
  ctx: { workspaceSlug: string; now: Date },
): ApprovalCandidate {
  const risk = Risk.safeParse(row.riskLevel);
  if (!risk.success)
    throw new ApprovalMappingError("risk_level", row.riskLevel);
  return {
    id: PublicId.parse(row.publicId),
    runId: null,
    workspaceSlug: Slug.parse(ctx.workspaceSlug),
    status: approvalStatus(row, ctx.now),
    chain: {
      operatorId: null,
      agentKey: null,
      action: null,
      trigger: null,
    },
    capabilityName: row.capabilityName,
    risk: risk.data,
    sideEffect: null,
    egress: null,
    amount: null,
    counterparty: null,
    mandateId: null,
    policyVersionId: null,
    inputDigest: null,
    tainted: null,
    tier: null,
    requestedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    approvers: null,
    rules: null,
    taintSources: null,
  };
}

/** A column value outside the vocabulary its CHECK constraint allows. */
export class ApprovalMappingError extends Error {
  readonly code = "approval_mapping_drift";
  constructor(
    readonly column: string,
    readonly value: unknown,
  ) {
    super(`unmapped ${column}: ${JSON.stringify(value)}`);
    this.name = "ApprovalMappingError";
  }
}
