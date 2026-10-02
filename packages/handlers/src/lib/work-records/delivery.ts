// delivery.ts: a work order on the existing command channel (P1-04, ADR-250).
//
// A send reaches its runtime as one `work_order` row in
// `tacho.control_commands`, addressed to the target's enrolled host. The
// host's command poll (`fetch_commands`) carries it, at least once, with the
// 60-second redelivery lease every command has. The host keeps it for the
// person at the host, and nothing starts until the host claims the order
// (`claim_work_order`), which the store refuses on a send that has ended.
//
// The row takes the order's idempotency key, which a unique index holds once
// per workspace. Every write here runs inside the transaction that holds the
// work item's row lock, so a retried send reads the row it wrote and returns
// it, and the index is the backstop.
//
// A stop reaches the run the same way the Runs page stops one: a `cancel`
// row addressed to the run's session and carried by its host. Its key names
// the order and the run, so a repeated stop queues one cancel.
import { schema, type Tx } from "@oxagen/database";
import { WorkRecordError } from "@oxagen/work/records";
import { and, eq, inArray } from "drizzle-orm";
import type { WorkScope } from "./store";

const commands = schema.tachoControlCommands;

/** The command a send wrote, or found from an earlier try. */
export interface QueuedCommand {
  /** The command's public id (`tcm_…`). */
  publicId: string;
  /** False when the row was already there: a retry. */
  created: boolean;
}

/** What the `work_order` command carries. The host claims the order to read the brief. */
export interface WorkOrderCommandInput {
  /** The work order's public id (`wo_…`). */
  workOrder: string;
  /** The work order's idempotency key. */
  key: string;
  /** The work item's public id (`wi_…`). */
  item: string;
  hostId: string;
  hostPublicId: string;
  issuedByUserId: string;
}

async function byKey(tx: Tx, scope: WorkScope, key: string): Promise<string | null> {
  const [row] = await tx
    .select({ publicId: commands.publicId })
    .from(commands)
    .where(and(eq(commands.orgId, scope.orgId), eq(commands.workspaceId, scope.workspaceId), eq(commands.idempotencyKey, key)))
    .limit(1);
  return row?.publicId ?? null;
}

/**
 * Queue the `work_order` command for a send, or return the one an earlier try
 * queued. The caller holds the work item's row lock.
 */
export async function queueWorkOrderCommand(tx: Tx, scope: WorkScope, input: WorkOrderCommandInput): Promise<QueuedCommand> {
  const existing = await byKey(tx, scope, input.key);
  if (existing !== null) return { publicId: existing, created: false };
  const now = new Date();
  const [row] = await tx
    .insert(commands)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      hostId: input.hostId,
      sessionId: null,
      targetKind: "host",
      targetId: input.hostPublicId,
      command: "work_order",
      payload: { work_order: input.workOrder, key: input.key, item: input.item },
      requestedMode: null,
      deliveryMode: null,
      degradedReason: null,
      reason: null,
      issuedByUserId: input.issuedByUserId,
      issuedAt: now,
      // A send waits for its claim as long as the person leaves it out. A
      // withdrawal cancels the row.
      expiresAt: null,
      outcome: "queued",
      idempotencyKey: input.key,
      createdById: input.issuedByUserId,
      updatedById: input.issuedByUserId,
    })
    .returning({ publicId: commands.publicId });
  if (!row) throw new Error("queueWorkOrderCommand: the insert returned no row");
  return { publicId: row.publicId, created: true };
}

/**
 * Cancel a send's `work_order` command so no host is offered it again. A row
 * the host already took stays as it is: the claim it would make next is
 * refused, because the send has ended. Returns whether a row was cancelled.
 */
export async function cancelWorkOrderCommand(tx: Tx, scope: WorkScope, key: string, userId: string): Promise<boolean> {
  const rows = await tx
    .update(commands)
    .set({ outcome: "cancelled", outcomeDetail: "withdrawn", updatedAt: new Date(), updatedById: userId })
    .where(
      and(
        eq(commands.orgId, scope.orgId),
        eq(commands.workspaceId, scope.workspaceId),
        eq(commands.idempotencyKey, key),
        inArray(commands.outcome, ["draft", "queued", "sent"]),
      ),
    )
    .returning({ id: commands.id });
  return rows.length > 0;
}

/** The key of the `cancel` a stop queues for one run of one send. Pure. */
export function stopCommandKey(orderKey: string, runId: string): string {
  return `${orderKey}:stop:${runId}`;
}

/** A stop's `cancel` command for one run. */
export interface RunCancelInput {
  /** The work order's public id. */
  workOrder: string;
  orderKey: string;
  /** The run's public id (`tse_…`). */
  runId: string;
  reason: string;
  /** The person who asked for the stop. */
  userId: string | null;
}

/**
 * Queue a `cancel` to the run a send started, carried by the run's host, or
 * return the one already queued. A run Oxagen cannot address (a ledger run, or
 * a session with no host) is refused: the stop would never arrive.
 */
export async function queueRunCancel(tx: Tx, scope: WorkScope, input: RunCancelInput): Promise<QueuedCommand> {
  const key = stopCommandKey(input.orderKey, input.runId);
  const existing = await byKey(tx, scope, key);
  if (existing !== null) return { publicId: existing, created: false };
  const sessions = schema.tachoSessions;
  const [session] = await tx
    .select({ id: sessions.id, publicId: sessions.publicId, sessionUuid: sessions.sessionUuid, hostId: sessions.hostId })
    .from(sessions)
    .where(and(eq(sessions.orgId, scope.orgId), eq(sessions.workspaceId, scope.workspaceId), eq(sessions.publicId, input.runId)))
    .limit(1);
  if (!session || session.hostId === null) {
    throw new WorkRecordError("not_allowed", `Oxagen cannot reach run ${input.runId} to stop it. Stop it where it runs.`);
  }
  const now = new Date();
  const [row] = await tx
    .insert(commands)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      hostId: session.hostId,
      sessionId: session.id,
      targetKind: "run",
      targetId: session.publicId,
      command: "cancel",
      payload: { session_uuid: session.sessionUuid, work_order: input.workOrder },
      requestedMode: null,
      deliveryMode: null,
      degradedReason: null,
      reason: input.reason,
      issuedByUserId: input.userId,
      issuedAt: now,
      expiresAt: null,
      outcome: "queued",
      idempotencyKey: key,
      createdById: input.userId,
      updatedById: input.userId,
    })
    .returning({ publicId: commands.publicId });
  if (!row) throw new Error("queueRunCancel: the insert returned no row");
  return { publicId: row.publicId, created: true };
}
