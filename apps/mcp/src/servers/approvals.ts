// approvals.ts: the approval a parked served call waits on (lane M15;
// mcp-studio-spec, Call path, step 4).
//
// A rule that asks for a person parks the call in agent.approval_requests,
// the same table and inbox every other parked call uses. The agent calls
// the tool again with the same arguments. An approved row lets exactly one
// call through: the first retry claims it, and a later identical call opens
// a new approval. The row answers only for the run that asked and the tool
// version it asked about.
//
// This follows externalApproval in packages/agent/src/runtime/external-approval.ts,
// which needs a chat message and a conversation that a wrapped agent's call
// does not have.
import { schema, withTenantDb } from "@oxagen/database";
import { inputDigest } from "@oxagen/rules";
import { notifyApprovalRequested } from "@oxagen/rules/approval-notify";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { ApprovalRequest, ApprovalState, ServedApprovals } from "./types";

/** How long a person has to answer before the approval expires. */
export const APPROVAL_TTL_MS = 5 * 60_000;

const RISKS = new Set(["low", "medium", "high", "critical"]);

/**
 * The key that finds the approval for this exact call: this run on this
 * machine, this agent, this tool at this version, and these arguments.
 * Another run with the same arguments opens its own approval, and so does
 * a call after a publish changes the tool.
 */
export function servedResumeKey(request: ApprovalRequest): string {
  const { run } = request;
  return `served:${inputDigest({
    workspaceId: run.workspaceId,
    machine: run.machine,
    run: run.runPublicId,
    agent: request.agent.name,
    tool: request.tool,
    version: request.version,
    args: request.args,
  })}`;
}

/** The approvals in Postgres, bound to one run's tenant. */
export function postgresApprovals(now: () => number = Date.now): ServedApprovals {
  return {
    settle(request: ApprovalRequest): Promise<ApprovalState> {
      const { run } = request;
      return runInTenantScope({ orgId: run.orgId, workspaceId: run.workspaceId }, () =>
        withTenantDb(async (tx): Promise<ApprovalState> => {
          const resumeKey = servedResumeKey(request);
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${resumeKey}, 0))`);
          const a = schema.approvalRequests;
          const scope = and(
            eq(a.orgId, run.orgId),
            eq(a.workspaceId, run.workspaceId),
            eq(a.capabilityName, request.tool),
            eq(a.resumeKey, resumeKey),
            gt(a.expiresAt, new Date(now())),
            // A claimed approval let its one call through. It no longer answers for this call.
            isNull(a.tokenUsedAt),
          );
          const existing = await tx.query.approvalRequests.findFirst({ where: scope });
          if (existing !== undefined) {
            if (existing.resolution === "approved") {
              const [claimed] = await tx
                .update(a)
                .set({ tokenUsedAt: new Date(now()) })
                .where(and(scope, eq(a.id, existing.id), eq(a.resolution, "approved")))
                .returning({ id: a.id });
              if (claimed !== undefined) return { state: "approved", id: existing.publicId };
            }
            return { state: existing.resolution === null ? "pending" : "refused", id: existing.publicId };
          }

          const expiresAt = new Date(now() + APPROVAL_TTL_MS);
          const riskLevel = RISKS.has(request.risk) ? request.risk : "high";
          const [row] = await tx
            .insert(a)
            .values({
              orgId: run.orgId,
              workspaceId: run.workspaceId,
              messageId: null,
              capabilityName: request.tool,
              inputPreview: request.args,
              inputDigest: inputDigest(request.args),
              riskLevel,
              kind: "approval",
              ruleIds: [...request.reasons],
              expiresAt,
              resumeKey,
              runPublicId: run.runPublicId,
            })
            .returning({ publicId: a.publicId });
          if (row === undefined) throw new Error("Oxagen did not record the approval request.");
          await notifyApprovalRequested(tx, {
            orgId: run.orgId,
            workspaceId: run.workspaceId,
            capabilityName: request.tool,
            riskLevel,
            expiresAt,
          });
          return { state: "pending", id: row.publicId };
        }),
      );
    },
  };
}
