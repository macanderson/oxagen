// resolve_approval — the human decision on a paused tool call, and the one
// rev1 write ADR-052 bills (apps/app/ARCHITECTURE.md §1.5).
//
//   1. Role gate — assertOrgRole: org Owner or Admin, or workspace Owner or
//      Member (the contract's defaultRoles), for the signed-in user or the
//      creator of the API key (resolveActingUserId). The kernel's IAM check
//      allows every capability for a non-enterprise org, so the handler checks.
//   2. Read the row by either id form (#2906) inside the caller's org and
//      workspace while it is unexpired and unresolved. No row → HandlerError
//      conflict `approval_expired`.
//   3. On a row the mandate gate parked (ADR-059 decision 4), the mandate's
//      approval rule decides who answers (MC spec §6.9): an agent principal
//      is refused `agent_cannot_resolve_own_mandate`; the caller holds an
//      org role the workspace names for every consequence tag on the mandate
//      (assertConsequenceRole, INV-29); and, when the rule names approvers,
//      is one of them (assertApprover). Each refusal is `forbidden` and
//      leaves before the ledger or the row is touched.
//   4. One transaction: on a mandate row lock the mandate and, for `denied`,
//      release the reservation; then the UPDATE that sets the resolution,
//      guarded by the WHERE of step 2. The lock order is the one the gate
//      and the expiry job use: mandate row, then approval_requests. No row
//      matched at the UPDATE → `approval_expired`; the throw rolls the
//      release back, and leaves through the kernel's catch, so the usage
//      recorder never runs and the no-op is not a governed action (§3.9
//      item 15).
//   5. `approved` leaves the reservation held for the agent's retry, whose
//      receipt settles it. The output reports the settlement.
//   6. A matched row writes the approval.resolved feed row for the person
//      whose message parked the call, in the same transaction.
//   7. On a row that stores the parked call (ADR-118), the UPDATE queues it
//      when approved. This request then delivers it: the call runs now, as
//      its requester, through `resumeApprovedCall`, and the answer reads back
//      what became of it. The periodic worker (`approval/resume`) is the
//      fallback when this process fails between the decision and delivery.
//      Before this step the worker was the only delivery, so a call approved
//      in the last minute of its five-minute window expired unrun, and every
//      other one waited up to a minute with nothing reported back (#3127).

import { withTenantDb, schema, type Tx } from "@oxagen/database";
import {
  assertApprover,
  assertConsequenceRole,
  loadConsequenceRoles,
} from "@oxagen/iam/mandate-role";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CheckedContext } from "@oxagen/oxagen";
import { runOutsideGovernedAction } from "@oxagen/oxagen/kernel";
import { lockMandate, parseMandateRow, release } from "@oxagen/rules";
import { and, eq, sql } from "drizzle-orm";
import pino from "pino";
import { notifyResolution } from "../runtime/approval";
import { APPROVAL_RESOLVER_ROLES } from "@oxagen/rules/approval-notify";
import { approvalIdCondition } from "../runtime/approval-id";
import type {
  AgentApprovalResolveInput,
  AgentApprovalResolveOutput,
} from "@oxagen/oxagen/contracts/agent.approval.resolve";

export type { AgentApprovalResolveInput, AgentApprovalResolveOutput };

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { pkg: "agent.approval.resolve" },
});

export async function agentApprovalResolveHandler(
  input: AgentApprovalResolveInput,
  ctx: CheckedContext,
): Promise<AgentApprovalResolveOutput> {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    APPROVAL_RESOLVER_ROLES,
  );

  // `approvalId` arrives as the public id (apr_…) or the row uuid (#2906).
  // WHERE expires_at > now() guards against a late approver winning the race.
  const pending = and(
    approvalIdCondition(input.approvalId),
    eq(schema.approvalRequests.orgId, ctx.orgId),
    eq(schema.approvalRequests.workspaceId, ctx.workspaceId),
    sql`${schema.approvalRequests.expiresAt} > now()`,
    sql`${schema.approvalRequests.resolution} IS NULL`,
  );
  const expired = () =>
    new HandlerError({
      code: "conflict",
      reason: "approval_expired",
      message: "The approval is not pending in this workspace",
    });

  const found = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select({
        mandateId: schema.approvalRequests.mandateId,
        toolCallId: schema.approvalRequests.toolCallId,
      })
      .from(schema.approvalRequests)
      .where(pending)
      .limit(1);
    if (!row) return null;
    if (!row.mandateId || !row.toolCallId) return { row, parked: null };
    const [mandateRow] = await tx
      .select()
      .from(schema.mandates)
      .where(eq(schema.mandates.id, row.mandateId))
      .limit(1);
    if (!mandateRow) throw expired();
    return {
      row,
      parked: {
        mandateId: row.mandateId,
        toolCallId: row.toolCallId,
        mandate: parseMandateRow(mandateRow),
        overrides: await loadConsequenceRoles(tx, ctx.workspaceId),
      },
    };
  });
  if (!found) throw expired();

  const { parked } = found;
  if (parked) {
    if (
      ctx.principal?.kind === "agent" ||
      ctx.agentRun?.principalKind === "agent"
    ) {
      throw new HandlerError({
        code: "forbidden",
        reason: "agent_cannot_resolve_own_mandate",
        message: "A call a mandate parked is answered by a person",
      });
    }
    await assertConsequenceRole(
      ctx,
      parked.mandate.consequenceTags,
      parked.overrides,
    );
    await assertApprover(ctx, parked.mandate.approval.approvers);
  }

  const { rowId, mandate, resumeStatus } = await withTenantDb(async (tx) => {
    const mandate = parked
      ? await settleMandateReservation(tx, parked, input.decision)
      : null;
    if (parked && mandate === null) throw expired();
    const [updated] = await tx
      .update(schema.approvalRequests)
      .set({
        resolution: input.decision,
        resumeStatus: sql`CASE WHEN ${schema.approvalRequests.resumePayload} IS NOT NULL THEN ${input.decision === "approved" ? "queued" : "denied"} ELSE ${schema.approvalRequests.resumeStatus} END`,
        resolvedAt: new Date(),
        resolvedByUserId: actingUserId,
        note: input.note ?? null,
      })
      .where(pending)
      .returning({
        id: schema.approvalRequests.id,
        messageId: schema.approvalRequests.messageId,
        capabilityName: schema.approvalRequests.capabilityName,
        // After the CASE above: `queued` or `denied` on a row that stores
        // the call, whatever it held before on any other row.
        resumeStatus: schema.approvalRequests.resumeStatus,
      });
    if (!updated) throw expired();

    // MC spec §7.7 approval.resolved: the person whose message parked the
    // call hears the decision, written with the decision. A person who
    // resolves their own approval already knows. approval_requests.message_id
    // is nullable — an approval a run parked outside any conversation has no
    // requester to tell, so there is nobody to look up.
    const messageId = updated.messageId;
    if (messageId) {
      const [requester] = await tx
        .select({ userId: schema.conversations.userId })
        .from(schema.messages)
        .innerJoin(
          schema.conversations,
          eq(schema.conversations.id, schema.messages.conversationId),
        )
        .where(
          and(
            eq(schema.messages.id, messageId),
            eq(schema.messages.orgId, ctx.orgId),
            eq(schema.messages.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (requester && requester.userId !== actingUserId) {
        await tx.insert(schema.notifications).values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          userId: requester.userId,
          kind: "approval",
          event: "approval.resolved",
          title: `Approval ${input.decision}: ${updated.capabilityName}`,
          body: input.note ?? null,
          deepLink: null,
        });
      }
    }
    return {
      rowId: updated.id,
      mandate,
      resumeStatus: updated.resumeStatus ?? null,
    };
  });

  // Waiters are keyed by the row uuid (createApprovalRequest returns it), so
  // notify with the uuid from RETURNING, never with the caller's id form.
  await notifyResolution({
    approvalId: rowId,
    resolution: input.decision,
    note: input.note ?? null,
  });
  const execution = await deliverDecision(
    { id: rowId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    resumeStatus,
  );
  return {
    approvalId: input.approvalId,
    resolution: input.decision,
    mandate,
    execution,
  };
}

type Execution = NonNullable<AgentApprovalResolveOutput["execution"]>;

/**
 * Run the call this decision released, and say what became of it.
 *
 * Null for a row that stores no call: a mandate row, a legacy row, a budget
 * pause. A denied call is never run, so its answer is the row's `denied`.
 *
 * An approved call runs through `resumeApprovedCall`, the one path the
 * periodic worker also takes, so both deliveries share its durable claim: the
 * first to claim the row runs the call and the other finds nothing to claim.
 * It runs outside this governed action (`runOutsideGovernedAction`), so the
 * call is its own top-level invocation, metered and admitted exactly as when
 * the worker delivers it, and never billed as part of the decision.
 *
 * The decision has committed by now, so nothing here may undo it. A delivery
 * that throws is logged and the row is read as it stands: still `queued` for
 * the worker, or `running` if the claim landed before the failure.
 */
async function deliverDecision(
  ref: { id: string; orgId: string; workspaceId: string },
  resumeStatus: string | null,
): Promise<Execution | null> {
  if (resumeStatus === null) return null;
  if (resumeStatus === "queued") {
    try {
      const { resumeApprovedCall } = await import("../runtime/approval-resume");
      await runOutsideGovernedAction(() => resumeApprovedCall(ref));
    } catch (err) {
      logger.error(
        { err, approvalId: ref.id, orgId: ref.orgId },
        "approved call was not delivered in the deciding request; the periodic worker will retry while it is still queued",
      );
    }
  }
  return readExecution(ref, resumeStatus);
}

/** The row's execution as it stands, which is what Fleet and the flyout both read. */
async function readExecution(
  ref: { id: string; orgId: string; workspaceId: string },
  fallback: string,
): Promise<Execution> {
  const a = schema.approvalRequests;
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        resumeStatus: a.resumeStatus,
        resumeRunPublicId: a.resumeRunPublicId,
        resumeError: a.resumeError,
      })
      .from(a)
      .where(
        and(
          eq(a.id, ref.id),
          eq(a.orgId, ref.orgId),
          eq(a.workspaceId, ref.workspaceId),
        ),
      )
      .limit(1),
  );
  return {
    status: row?.resumeStatus ?? fallback,
    runId: row?.resumeRunPublicId ?? null,
    reason: row?.resumeError ?? null,
  };
}

type MandateSettlement = AgentApprovalResolveOutput["mandate"];

/**
 * The reservation the parked call holds, released on `denied` and left held
 * on `approved`, in the caller's transaction. Takes the mandate row lock
 * first, so a concurrent gate decision on the same mandate serialises with
 * the release, then reads the reserve rows still open for the call. Null
 * when the mandate row is gone.
 */
async function settleMandateReservation(
  tx: Tx,
  parked: { mandateId: string; toolCallId: string },
  decision: "approved" | "denied",
): Promise<MandateSettlement> {
  const { mandateId, toolCallId } = parked;
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
}
