// approvals.ts: the approval a parked served call waits on (lane M15;
// mcp-studio-spec, Call path, step 4).
//
// A rule that asks for a person parks the call in agent.approval_requests,
// the same table and inbox every other parked call uses. The agent calls
// the tool again with the same arguments. The approvals answer only for the
// run that asked, the tool version it asked about, and the publication it
// was decided under.
//
// A rule can ask for more than one person (payments.two-approvers). Settling
// counts the distinct people who approved the call. When the count is too
// few for the rule, the call opens one more approval and parks again. When
// the count is enough, claiming marks every approval used, so the approvals
// let exactly one call through and a later identical call asks again (#4666).
//
// This follows externalApproval in packages/agent/src/runtime/external-approval.ts,
// which needs a chat message and a conversation that a wrapped agent's call
// does not have.
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { inputDigest } from "@oxagen/rules";
import { notifyApprovalRequested } from "@oxagen/rules/approval-notify";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { ApprovalRequest, ApprovalState, ServedApprovals } from "./types";

/** How long a person has to answer before the approval expires. */
export const APPROVAL_TTL_MS = 5 * 60_000;

const RISKS = new Set(["low", "medium", "high", "critical"]);

/**
 * The key that finds the approval for this exact call: this run on this
 * machine, this agent, this tool at this version under this publication,
 * and these arguments. Another run with the same arguments opens its own
 * approval, and so does a call after any new publish.
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
    publication: request.publication,
    args: request.args,
  })}`;
}

type ApprovalRows = typeof schema.approvalRequests;

/** The rows that answer for this call: this key, unexpired, and not yet used. */
function answering(a: ApprovalRows, request: ApprovalRequest, resumeKey: string, at: Date) {
  const { run } = request;
  return and(
    eq(a.orgId, run.orgId),
    eq(a.workspaceId, run.workspaceId),
    eq(a.capabilityName, request.tool),
    eq(a.resumeKey, resumeKey),
    gt(a.expiresAt, at),
    // A used approval let its one call through. It no longer answers for this call.
    isNull(a.tokenUsedAt),
  );
}

/** The distinct people among approved rows. An auto-approval names no person, so it counts none. */
function approversOf(rows: ReadonlyArray<{ resolvedByUserId: string | null }>): number {
  return new Set(rows.flatMap((row) => (row.resolvedByUserId === null ? [] : [row.resolvedByUserId]))).size;
}

/** Run `fn` in the run's tenant, holding the lock on this call's key for the transaction. */
function locked<T>(request: ApprovalRequest, fn: (tx: Tx, resumeKey: string) => Promise<T>): Promise<T> {
  const { run } = request;
  return runInTenantScope({ orgId: run.orgId, workspaceId: run.workspaceId }, () =>
    withTenantDb(async (tx) => {
      const resumeKey = servedResumeKey(request);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${resumeKey}, 0))`);
      return fn(tx, resumeKey);
    }),
  );
}

/** Open a pending approval for the call and tell the people who can answer it. */
async function open(tx: Tx, request: ApprovalRequest, resumeKey: string, at: number): Promise<string> {
  const { run } = request;
  const a = schema.approvalRequests;
  const expiresAt = new Date(at + APPROVAL_TTL_MS);
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
  return row.publicId;
}

/** The approvals in Postgres, bound to one run's tenant. */
export function postgresApprovals(now: () => number = Date.now): ServedApprovals {
  const a = schema.approvalRequests;
  // Each transaction reads the clock once, so the rows it counts and the rows it marks are the same rows.
  const rowsOf = (tx: Tx, request: ApprovalRequest, resumeKey: string, at: Date) =>
    tx
      .select({ publicId: a.publicId, resolution: a.resolution, resolvedByUserId: a.resolvedByUserId })
      .from(a)
      .where(answering(a, request, resumeKey, at))
      .orderBy(asc(a.createdAt));
  return {
    settle(request: ApprovalRequest): Promise<ApprovalState> {
      return locked(request, async (tx, resumeKey): Promise<ApprovalState> => {
        const at = now();
        const rows = await rowsOf(tx, request, resumeKey, new Date(at));
        const refused = rows.find((row) => row.resolution !== null && row.resolution !== "approved");
        if (refused !== undefined) return { state: "refused", id: refused.publicId };
        const pending = rows.find((row) => row.resolution === null);
        if (pending !== undefined) return { state: "pending", id: pending.publicId };
        const [first] = rows;
        if (first !== undefined) return { state: "approved", id: first.publicId, approvers: approversOf(rows) };
        return { state: "pending", id: await open(tx, request, resumeKey, at) };
      });
    },

    requestAnother(request: ApprovalRequest): Promise<{ id: string }> {
      return locked(request, async (tx, resumeKey) => {
        const at = now();
        const pending = (await rowsOf(tx, request, resumeKey, new Date(at))).find((row) => row.resolution === null);
        return { id: pending?.publicId ?? (await open(tx, request, resumeKey, at)) };
      });
    },

    claim(request: ApprovalRequest, approvers: number): Promise<boolean> {
      return locked(request, async (tx, resumeKey) => {
        const at = new Date(now());
        const rows = await rowsOf(tx, request, resumeKey, at);
        // A refusal or a new pending approval since the call settled leaves the approvals unused.
        if (rows.length === 0 || rows.some((row) => row.resolution !== "approved")) return false;
        if (approversOf(rows) < approvers) return false;
        // Every approval under the key, not one: a call two people approved uses both.
        const used = await tx
          .update(a)
          .set({ tokenUsedAt: at })
          .where(and(answering(a, request, resumeKey, at), eq(a.resolution, "approved")))
          .returning({ publicId: a.publicId });
        return used.length > 0;
      });
    },
  };
}
