// resolve_approval — the human decision on a paused tool call, and the one
// rev1 write ADR-052 bills (apps/app/ARCHITECTURE.md §1.5).
//
//   1. Role gate — assertOrgRole: org Owner or Admin, or workspace Owner or
//      Member (the contract's defaultRoles). The kernel's IAM check allows
//      every capability for a non-enterprise org, so the handler checks.
//   2. One UPDATE that matches the row by either id form (#2906), inside the
//      caller's org and workspace, only while it is unexpired and unresolved.
//   3. No row matched → HandlerError conflict `approval_expired`. The throw
//      leaves through the kernel's catch, so the usage recorder never runs and
//      the no-op is not a governed action (§3.9 item 15).
//   4. A row the mandate gate parked carries `mandate_id` and `tool_call_id`
//      (ADR-059 decision 4): `denied` releases the reservation under the
//      mandate row lock; `approved` leaves it held for the agent's retry,
//      whose receipt settles it. The output reports the settlement.

import { withTenantDb, schema } from "@oxagen/database";
import { assertOrgRole } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen";
import { lockMandate, release } from "@oxagen/rules";
import { and, eq, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import { notifyResolution } from "../runtime/approval";
import { approvalIdCondition } from "../runtime/approval-id";
import type {
  AgentApprovalResolveInput,
  AgentApprovalResolveOutput,
} from "@oxagen/oxagen/contracts/agent.approval.resolve";

export type { AgentApprovalResolveInput, AgentApprovalResolveOutput };

export async function agentApprovalResolveHandler(
  input: AgentApprovalResolveInput,
  ctx: CapabilityContext,
): Promise<AgentApprovalResolveOutput> {
  await assertOrgRole(ctx, {
    org: ["Owner", "Admin"],
    workspace: ["Owner", "Member"],
  });

  // `approvalId` arrives as the public id (apr_…) or the row uuid (#2906).
  // Reject expired rows atomically: WHERE expires_at > now() guards
  // against a late approver winning the race.
  const updated = await withTenantDb((tx) =>
    tx
      .update(schema.approvalRequests)
      .set({
        resolution: input.decision,
        resolvedAt: new Date(),
        resolvedByUserId: ctx.userId,
        note: input.note ?? null,
      })
      .where(
        and(
          approvalIdCondition(input.approvalId),
          eq(schema.approvalRequests.orgId, ctx.orgId),
          eq(schema.approvalRequests.workspaceId, ctx.workspaceId),
          sql`${schema.approvalRequests.expiresAt} > now()`,
          sql`${schema.approvalRequests.resolution} IS NULL`,
        ),
      )
      .returning({
        id: schema.approvalRequests.id,
        mandateId: schema.approvalRequests.mandateId,
        toolCallId: schema.approvalRequests.toolCallId,
      }),
  );

  const row = updated[0];
  if (!row) {
    throw new HandlerError({
      code: "conflict",
      reason: "approval_expired",
      message: "The approval is not pending in this workspace",
    });
  }

  const mandate = await settleMandateReservation(row, input.decision);

  // Waiters are keyed by the row uuid (createApprovalRequest returns it), so
  // notify with the uuid from RETURNING, never with the caller's id form.
  await notifyResolution({
    approvalId: row.id,
    resolution: input.decision,
    note: input.note ?? null,
  });
  return { approvalId: input.approvalId, resolution: input.decision, mandate };
}

type MandateSettlement = AgentApprovalResolveOutput["mandate"];

/**
 * The reservation the parked call holds, released on `denied` and left held
 * on `approved`. Reads the reserve rows still open for the call under the
 * mandate row lock, so a concurrent gate decision on the same mandate
 * serialises with the release.
 */
async function settleMandateReservation(
  row: { mandateId: string | null; toolCallId: string | null },
  decision: "approved" | "denied",
): Promise<MandateSettlement> {
  if (!row.mandateId || !row.toolCallId) return null;
  const { mandateId, toolCallId } = row;
  return withTenantDb(async (tx) => {
    const mandate = await lockMandate(tx, mandateId);
    if (mandate === null) return null;
    const l = schema.mandateLedger;
    const rows = await tx
      .select({
        measure: l.measure,
        value: l.value,
        unitOrCurrency: l.unitOrCurrency,
        kind: l.kind,
      })
      .from(l)
      .where(and(eq(l.mandateId, mandateId), eq(l.toolCallId, toolCallId)));
    const closed = new Set(
      rows.filter((r) => r.kind !== "reserve").map((r) => r.measure),
    );
    const reserved = rows
      .filter((r) => r.kind === "reserve" && !closed.has(r.measure))
      .map(({ measure, value, unitOrCurrency }) => ({
        measure,
        value,
        unitOrCurrency,
      }));
    if (decision === "denied") await release(tx, { mandate, toolCallId });
    return {
      mandateId: mandate.publicId,
      reserved,
      outcome: decision === "denied" ? "released" : "held",
    };
  });
}
