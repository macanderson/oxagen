// actions.ts: a person's actions on a work item, on the P1-02 store (P1-04).
//
// Each action runs inside the caller's tenant transaction after the handler
// checked the person (actor.ts), and writes only through the store, which
// locks the item row, checks the version the person read, and asks
// admitDecision whether the item's state allows the action (ADR-244). A work
// item grants no authority: a send reads its target, the sender's operator
// relationship, and the mandate on the server (target.ts).
//
// Accept is not here. It reads GitHub between two transactions (accept.ts).
import { schema, type Tx } from "@oxagen/database";
import type { Sha256Digest } from "@oxagen/run-evidence";
import {
  type CloseResolution,
  type FactInput,
  type FactKind,
  type GovernanceMode,
  type OrderProjection,
  type WorkItemProjection,
  WorkRecordError,
  workOrderKey,
} from "@oxagen/work/records";
import { and, eq } from "drizzle-orm";
import type { WorkActor } from "./actor";
import { cancelWorkOrderCommand, queueRunCancel, queueWorkOrderCommand } from "./delivery";
import {
  appendFacts,
  approveBrief,
  openWorkOrder,
  reopenWorkItem,
  saveBrief,
  type WorkItemRecord,
  type WorkOrderWrite,
  type WorkScope,
  type WorkWrite,
} from "./store";
import { readSendTarget, type SendTarget } from "./target";

/** The work item after a write, as every action answers it. */
export interface ItemAfter {
  id: string;
  state: WorkItemProjection["state"];
  revision: number;
  version: number;
}

/** One send after a write. */
export interface OrderAfter {
  id: string;
  send: number;
  key: string;
  delivery: OrderProjection["delivery"];
}

/** The item's public id, state, revision, and version. Pure. */
export function itemAfter(record: Pick<WorkItemRecord, "publicId" | "projection" | "version">): ItemAfter {
  return { id: record.publicId, state: record.projection.state, revision: record.projection.revision, version: record.version };
}

/** One send as the projection holds it. Pure. */
export function orderAfter(projection: Pick<WorkItemProjection, "orders">, orderId: string, publicId: string): OrderAfter {
  const order = projection.orders.find((entry) => entry.orderId === orderId);
  if (order === undefined) throw new WorkRecordError("not_found", "This work item has no such send.");
  return { id: publicId, send: order.send, key: order.key, delivery: order.delivery };
}

/** The work item's row id for its public id in this workspace. */
export async function resolveItemId(tx: Tx, scope: WorkScope, publicId: string): Promise<string> {
  const items = schema.workItems;
  const [row] = await tx
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId), eq(items.publicId, publicId)))
    .limit(1);
  if (!row) throw new WorkRecordError("not_found", "This workspace has no such work item.");
  return row.id;
}

/** A send of this work item, by its public id. */
export interface OrderRef {
  id: string;
  publicId: string;
  key: string;
  agentId: string;
}

/** The send `publicId` of the work item `itemId` in this workspace. */
export async function resolveOrder(tx: Tx, scope: WorkScope, itemId: string, publicId: string): Promise<OrderRef> {
  const orders = schema.workOrders;
  const [row] = await tx
    .select({ id: orders.id, publicId: orders.publicId, key: orders.idempotencyKey, agentId: orders.agentId })
    .from(orders)
    .where(
      and(
        eq(orders.orgId, scope.orgId),
        eq(orders.workspaceId, scope.workspaceId),
        eq(orders.itemId, itemId),
        eq(orders.publicId, publicId),
      ),
    )
    .limit(1);
  if (!row) throw new WorkRecordError("not_found", "This work item has no such send.");
  return { ...row, publicId: String(row.publicId) };
}

/**
 * A person's decision fact. The store replaces its time, dedupe key, and item
 * revision with its own under the row lock, so these are placeholders.
 */
function decision<K extends FactKind>(kind: K, actor: WorkActor, data: FactInput<K>["data"], orderId: string | null = null): FactInput<FactKind> {
  return {
    kind,
    source: "person",
    itemRevision: 1,
    orderId,
    actor: actor.userId,
    occurredAt: new Date(0).toISOString(),
    dedupeKey: kind,
    data,
  } as FactInput<FactKind>;
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export interface SaveBriefAction {
  item_id: string;
  version: number;
  item_revision: number;
  repository: string;
  criteria: {
    id?: string | null;
    text: string;
    tag: "code" | "test" | "docs" | "review";
    intent: "check" | "review";
    evidence?: string | null;
    provenance: "source" | "triage" | "person";
  }[];
}

export async function saveWorkBrief(tx: Tx, scope: WorkScope, actor: WorkActor, input: SaveBriefAction) {
  const itemId = await resolveItemId(tx, scope, input.item_id);
  const write = await saveBrief(tx, scope, {
    itemId,
    expectedVersion: input.version,
    itemRevision: input.item_revision,
    draft: {
      repository: input.repository,
      criteria: input.criteria.map((criterion) => ({
        id: criterion.id ?? null,
        text: criterion.text,
        tag: criterion.tag,
        intent: criterion.intent,
        evidence: criterion.evidence ?? null,
        provenance: criterion.provenance,
      })),
    },
    actor: actor.userId,
    source: "person",
    actorUserId: actor.userId,
  });
  const latest = write.projection.latestBrief;
  if (latest === null) throw new Error("save_work_brief: the saved brief is missing from the projection");
  return { item: itemAfter(write), repeat: write.repeat, brief: { revision: latest.revision, digest: latest.digest } };
}

export interface ApproveBriefAction {
  item_id: string;
  version: number;
  item_revision: number;
  brief_revision: number;
  brief_digest: string;
}

export async function approveWorkBrief(tx: Tx, scope: WorkScope, actor: WorkActor, input: ApproveBriefAction) {
  const itemId = await resolveItemId(tx, scope, input.item_id);
  const write = await approveBrief(tx, scope, {
    itemId,
    expectedVersion: input.version,
    itemRevision: input.item_revision,
    briefRevision: input.brief_revision,
    briefDigest: input.brief_digest as Sha256Digest,
    actorUserId: actor.userId,
  });
  return { item: itemAfter(write), repeat: write.repeat };
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendAction {
  item_id: string;
  version: number;
  item_revision: number;
  brief_revision: number;
  brief_digest: string;
  agent_id: string;
  key: string;
}

/** What a send answers, beside the item. */
export interface SendResult {
  write: WorkOrderWrite;
  target: SendTarget;
  commandId: string;
}

/** Refuse a target whose host cannot take a work order yet. */
function assertDeliverable(target: SendTarget): void {
  if (!target.host.takesWorkOrders) {
    throw new WorkRecordError(
      "not_allowed",
      `${target.host.hostname} runs a version of oxagen that cannot receive work orders. Update oxagen on that machine, then send again.`,
    );
  }
}

async function openAndQueue(
  tx: Tx,
  scope: WorkScope,
  actor: WorkActor,
  input: { itemId: string; version: number; itemRevision: number; briefRevision: number; briefDigest: Sha256Digest; key: string },
  target: SendTarget,
  governanceMode: GovernanceMode,
): Promise<SendResult> {
  assertDeliverable(target);
  const write = await openWorkOrder(tx, scope, {
    itemId: input.itemId,
    expectedVersion: input.version,
    itemRevision: input.itemRevision,
    briefRevision: input.briefRevision,
    briefDigest: input.briefDigest,
    idempotencyKey: input.key,
    agentId: target.agentId,
    runtimeId: target.runtimeId,
    runtimeTier: target.runtimeTier,
    mandateId: target.mandateId,
    // Nothing reserves budget at send (ADR-251): the gateway holds it before
    // each model call on the gateway and contained tiers, and spend is
    // recorded after the run on the harness and observe tiers.
    budgetReservationId: null,
    operatorId: actor.userId,
    governanceMode,
    operatesAgent: target.operatesAgent,
  });
  const command = await queueWorkOrderCommand(tx, scope, {
    workOrder: write.orderPublicId,
    key: input.key,
    item: write.publicId,
    hostId: target.host.id,
    hostPublicId: target.host.publicId,
    issuedByUserId: actor.userId,
  });
  return { write, target, commandId: command.publicId };
}

/** The send answer the contract returns. Pure. */
export function sendOutput(result: SendResult) {
  const { write, target } = result;
  return {
    item: itemAfter(write),
    repeat: write.repeat,
    order: orderAfter(write.projection, write.orderId, write.orderPublicId),
    command_id: result.commandId,
    target: {
      agent_id: target.agentPublicId,
      runtime_id: target.runtimePublicId,
      host_id: target.host.publicId,
      runtime_tier: target.runtimeTier,
      mandate_id: target.mandateId,
    },
  };
}

export async function sendWork(tx: Tx, scope: WorkScope, actor: WorkActor, input: SendAction, governanceMode: GovernanceMode): Promise<SendResult> {
  const itemId = await resolveItemId(tx, scope, input.item_id);
  const target = await readSendTarget(tx, scope, input.agent_id, actor.userId);
  return openAndQueue(
    tx,
    scope,
    actor,
    {
      itemId,
      version: input.version,
      itemRevision: input.item_revision,
      briefRevision: input.brief_revision,
      briefDigest: input.brief_digest as Sha256Digest,
      key: input.key,
    },
    target,
    governanceMode,
  );
}

// ---------------------------------------------------------------------------
// Withdraw, stop, return
// ---------------------------------------------------------------------------

export interface OrderAction {
  item_id: string;
  version: number;
  work_order_id: string;
  reason: string;
}

export async function cancelWork(tx: Tx, scope: WorkScope, actor: WorkActor, input: OrderAction) {
  const itemId = await resolveItemId(tx, scope, input.item_id);
  const order = await resolveOrder(tx, scope, itemId, input.work_order_id);
  const write = await appendFacts(tx, scope, {
    itemId,
    expectedVersion: input.version,
    actorUserId: actor.userId,
    facts: [decision("send_withdrawn", actor, { reason: input.reason }, order.id)],
  });
  await cancelWorkOrderCommand(tx, scope, order.key, actor.userId);
  return { item: itemAfter(write), repeat: write.repeat, order: orderAfter(write.projection, order.id, order.publicId) };
}

export async function stopWork(tx: Tx, scope: WorkScope, actor: WorkActor, input: OrderAction) {
  const itemId = await resolveItemId(tx, scope, input.item_id);
  const order = await resolveOrder(tx, scope, itemId, input.work_order_id);
  const write = await appendFacts(tx, scope, {
    itemId,
    expectedVersion: input.version,
    actorUserId: actor.userId,
    facts: [decision("stop_requested", actor, { reason: input.reason }, order.id)],
  });
  const after = write.projection.orders.find((entry) => entry.orderId === order.id);
  const runId = after?.runIds[after.runIds.length - 1];
  let commandId: string | null = null;
  // A stop before the run links reaches the run when it links (runtime.ts).
  if (after?.delivery === "stopping" && runId !== undefined) {
    const command = await queueRunCancel(tx, scope, {
      workOrder: order.publicId,
      orderKey: order.key,
      runId,
      reason: input.reason,
      userId: actor.userId,
    });
    commandId = command.publicId;
  }
  return {
    item: itemAfter(write),
    repeat: write.repeat,
    order: orderAfter(write.projection, order.id, order.publicId),
    command_id: commandId,
  };
}

export interface ReturnAction extends OrderAction {
  resend: boolean;
}

async function agentPublicIdOf(tx: Tx, scope: WorkScope, agentId: string): Promise<string | null> {
  const [row] = await tx
    .select({ publicId: schema.agents.publicId })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, scope.orgId), eq(schema.agents.workspaceId, scope.workspaceId)))
    .limit(1);
  return row ? String(row.publicId) : null;
}

/**
 * Return a send's result. The return is recorded in any case. With `resend`,
 * the item goes out again to the same agent in a savepoint: when that send is
 * refused (the agent is busy, the item changed, a duty rule), the return still
 * stands, the item waits in ready, and the answer says why.
 */
export async function returnWork(tx: Tx, scope: WorkScope, actor: WorkActor, input: ReturnAction, governanceMode: GovernanceMode) {
  const itemId = await resolveItemId(tx, scope, input.item_id);
  const order = await resolveOrder(tx, scope, itemId, input.work_order_id);
  const returned: WorkWrite = await appendFacts(tx, scope, {
    itemId,
    expectedVersion: input.version,
    actorUserId: actor.userId,
    facts: [decision("returned", actor, { reason: input.reason }, order.id)],
  });
  const base = {
    item: itemAfter(returned),
    repeat: returned.repeat,
    order: orderAfter(returned.projection, order.id, order.publicId),
    resent: null as OrderAfter | null,
    resend_refused: null as string | null,
  };
  if (!input.resend || returned.repeat) return base;

  const approved = returned.projection.approvedBrief;
  if (approved === null) {
    return { ...base, resend_refused: `The item changed to revision ${returned.projection.revision}. Approve its brief, then send it.` };
  }
  const agentPublicId = await agentPublicIdOf(tx, scope, order.agentId);
  if (agentPublicId === null) return { ...base, resend_refused: "The agent is no longer in this workspace." };
  try {
    const resent = await tx.transaction(async (savepoint) => {
      const target = await readSendTarget(savepoint as Tx, scope, agentPublicId, actor.userId);
      return openAndQueue(
        savepoint as Tx,
        scope,
        actor,
        {
          itemId,
          version: returned.version,
          itemRevision: returned.projection.revision,
          briefRevision: approved.revision,
          briefDigest: approved.digest,
          key: workOrderKey(returned.publicId, approved.revision, returned.projection.nextSend),
        },
        target,
        governanceMode,
      );
    });
    return {
      ...base,
      item: itemAfter(resent.write),
      resent: orderAfter(resent.write.projection, resent.write.orderId, resent.write.orderPublicId),
    };
  } catch (error) {
    if (error instanceof WorkRecordError) return { ...base, resend_refused: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Close and reopen
// ---------------------------------------------------------------------------

export interface CloseAction {
  item_id: string;
  version: number;
  resolution: CloseResolution;
  reason: string;
}

export async function closeWork(tx: Tx, scope: WorkScope, actor: WorkActor, input: CloseAction) {
  const itemId = await resolveItemId(tx, scope, input.item_id);
  const write = await appendFacts(tx, scope, {
    itemId,
    expectedVersion: input.version,
    actorUserId: actor.userId,
    facts: [decision("closed", actor, { resolution: input.resolution, reason: input.reason })],
  });
  return { item: itemAfter(write), repeat: write.repeat };
}

export async function reopenWork(tx: Tx, scope: WorkScope, actor: WorkActor, input: { item_id: string; version: number; reason: string }) {
  const itemId = await resolveItemId(tx, scope, input.item_id);
  const write = await reopenWorkItem(tx, scope, { itemId, expectedVersion: input.version, reason: input.reason, actorUserId: actor.userId });
  return { item: itemAfter(write), repeat: write.repeat };
}
