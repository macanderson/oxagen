// runtime.ts: what the runtime reports about a send, checked against the
// host that reports it (P1-04, ADR-250).
//
// A send is delivered to the target agent's enrolled host as a `work_order`
// command (delivery.ts). From there:
//
//   1. The host claims the order (`claimWorkOrder`). The claim is the
//      handshake before anything starts. It binds the send to this host, and
//      its answer is the first prompt of the run. A claim on a send that ended
//      is refused, so the host must not start it. One host claims a send: a
//      second host is refused, and the claiming host asking again after a lost
//      answer gets the same claim and prompt back.
//   2. The run that starts names the order on its first frame. Ingest calls
//      `linkWorkOrderRun`, which binds the run to the send only when the run's
//      host is the host that claimed it. The first run to link wins.
//   3. The run's seal records the end (`endWorkOrderRuns`).
//   4. A stop is a `cancel` to the run. When the host reports the cancel
//      applied, the send is stopped (`recordWorkOrderAcks`).
//
// Every fact here is the runtime's word, filed under the host credential that
// carried it. Nothing here is a person's decision, so none of it names an
// item version: the store locks the item row for each write and refuses a
// fact the item's state forbids.
import { schema, type Tx } from "@oxagen/database";
import {
  type FactInput,
  type FactKind,
  type OrderProjection,
  type WorkFact,
  WorkRecordError,
} from "@oxagen/work/records";
import { and, eq } from "drizzle-orm";
import { queueRunCancel } from "./delivery";
import { buildWorkOrderPrompt, type PromptSource } from "./prompt";
import { appendFacts, readWorkItem, type WorkItemRecord, type WorkScope, type WorkWrite } from "./store";

/** The enrolled host a runtime call came from, as `resolveEnrolledHost` read it. */
export interface ClaimingHost {
  id: string;
  publicId: string;
  runtimeId: string | null;
  agentId: string | null;
}

/** A work order row, as the runtime paths read it. */
interface OrderRow {
  id: string;
  publicId: string;
  itemId: string;
  key: string;
  runtimeId: string;
  agentId: string;
}

async function orderByPublicId(tx: Tx, scope: WorkScope, publicId: string): Promise<OrderRow> {
  const orders = schema.workOrders;
  const [row] = await tx
    .select({
      id: orders.id,
      publicId: orders.publicId,
      itemId: orders.itemId,
      key: orders.idempotencyKey,
      runtimeId: orders.runtimeId,
      agentId: orders.agentId,
    })
    .from(orders)
    .where(and(eq(orders.orgId, scope.orgId), eq(orders.workspaceId, scope.workspaceId), eq(orders.publicId, publicId)))
    .limit(1);
  if (!row) throw new WorkRecordError("not_found", "This workspace has no such work order.");
  return { ...row, publicId: String(row.publicId) };
}

/** Refuse a host that is not the target of the send. */
function assertTargetHost(order: OrderRow, host: ClaimingHost): void {
  if (host.runtimeId !== order.runtimeId) {
    throw new WorkRecordError("forbidden", "This work order went to another runtime. This host must not start it.");
  }
  if (host.agentId !== null && host.agentId !== order.agentId) {
    throw new WorkRecordError("forbidden", "This work order went to another agent. This host must not start it.");
  }
}

function orderOf(record: Pick<WorkItemRecord, "projection">, orderId: string): OrderProjection {
  const order = record.projection.orders.find((entry) => entry.orderId === orderId);
  if (order === undefined) throw new WorkRecordError("not_found", "This work item has no such send.");
  return order;
}

function claimOf(facts: readonly WorkFact[], orderId: string): WorkFact | undefined {
  return facts.find((fact) => fact.kind === "claimed" && fact.orderId === orderId);
}

function runtimeFact<K extends FactKind>(kind: K, order: OrderRow, actor: string, at: string, dedupeKey: string, data: FactInput<K>["data"], extra: Partial<FactInput<K>> = {}): FactInput<FactKind> {
  return { kind, source: "runtime", itemRevision: 1, orderId: order.id, actor, occurredAt: at, dedupeKey, data, ...extra } as FactInput<FactKind>;
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/** What a claim answers. */
export interface ClaimAnswer {
  repeat: boolean;
  order: OrderProjection;
  orderPublicId: string;
  itemPublicId: string;
  itemNumber: string;
  repository: string;
  agentPublicId: string;
  harness: string;
  prompt: string;
}

/** The source text at the revision a send went out on. Pure. */
export function sourceAt(record: Pick<WorkItemRecord, "facts" | "sourceUrl">, itemRevision: number): PromptSource | null {
  let latest: WorkFact | undefined;
  for (const fact of record.facts) {
    if (fact.kind !== "collected" && fact.kind !== "entered" && fact.kind !== "source_changed") continue;
    if (fact.itemRevision > itemRevision) continue;
    const later =
      latest === undefined ||
      fact.itemRevision > latest.itemRevision ||
      (fact.itemRevision === latest.itemRevision && Date.parse(fact.occurredAt) >= Date.parse(latest.occurredAt));
    if (later) latest = fact;
  }
  if (latest === undefined || (latest.kind !== "collected" && latest.kind !== "entered" && latest.kind !== "source_changed")) return null;
  return { url: record.sourceUrl, revision: latest.itemRevision, subject: latest.data.subject, description: latest.data.description };
}

/** The reason a person gave when they returned the send before this one, in this item's current cycle. Pure. */
export function returnedReasonBefore(orders: readonly OrderProjection[], send: number, reopenedAfterSend: number): string | null {
  const previous = orders.filter((order) => order.send < send && order.send > reopenedAfterSend).sort((a, b) => b.send - a.send)[0];
  return previous?.returned?.reason ?? null;
}

/**
 * Claim a work order for the host. Records the claim the first time, and
 * answers a repeat from the same host with the same claim. Refuses another
 * host, a host on another runtime, and a send that ended.
 */
export async function claimWorkOrder(tx: Tx, scope: WorkScope, host: ClaimingHost, orderPublicId: string, now: Date): Promise<ClaimAnswer> {
  const row = await orderByPublicId(tx, scope, orderPublicId);
  assertTargetHost(row, host);
  const write: WorkWrite = await appendFacts(tx, scope, {
    itemId: row.itemId,
    facts: [runtimeFact("claimed", row, host.publicId, now.toISOString(), `claimed:${row.id}`, { host: host.publicId })],
  });
  // The store treats a second claim fact as a repeat whatever host sent it,
  // so the stored claim decides who holds the send. It is read under the
  // lock the write took.
  const claim = claimOf(write.facts, row.id);
  if (claim === undefined || claim.kind !== "claimed" || claim.data.host !== host.publicId) {
    throw new WorkRecordError("conflict", "Another runtime already claimed this work order. This host must not start it.");
  }
  const order = orderOf(write, row.id);
  if (order.closed) {
    throw new WorkRecordError("not_allowed", `Send ${order.send} has ended (${order.delivery}). This host must not start it.`);
  }

  const brief = write.briefs.find((stored) => stored.briefId === order.briefId);
  if (brief === undefined) throw new WorkRecordError("not_found", "The work order's brief is missing.");
  const [item] = await tx
    .select({ number: schema.workItems.number })
    .from(schema.workItems)
    .where(and(eq(schema.workItems.id, row.itemId), eq(schema.workItems.orgId, scope.orgId)))
    .limit(1);
  const [agent] = await tx
    .select({ publicId: schema.agents.publicId, harness: schema.agents.harness })
    .from(schema.agents)
    .where(and(eq(schema.agents.id, row.agentId), eq(schema.agents.orgId, scope.orgId)))
    .limit(1);
  const itemNumber = item?.number ?? write.publicId;
  return {
    repeat: write.repeat,
    order,
    orderPublicId: row.publicId,
    itemPublicId: write.publicId,
    itemNumber,
    repository: brief.brief.repository,
    agentPublicId: agent ? String(agent.publicId) : "",
    harness: agent?.harness ?? "custom",
    prompt: buildWorkOrderPrompt({
      itemNumber,
      workOrder: row.publicId,
      briefRevision: order.briefRevision,
      brief: brief.brief,
      source: sourceAt(write, order.itemRevision),
      returnedReason: returnedReasonBefore(write.projection.orders, order.send, write.projection.reopenedAfterSend),
    }),
  };
}

/**
 * Record that the host cannot start the order. Refused once a run is linked:
 * that run's end is the record then.
 */
export async function rejectWorkOrder(tx: Tx, scope: WorkScope, host: ClaimingHost, orderPublicId: string, reason: string, now: Date): Promise<{ repeat: boolean }> {
  const row = await orderByPublicId(tx, scope, orderPublicId);
  assertTargetHost(row, host);
  const before = await readWorkItem(tx, scope, row.itemId);
  const current = orderOf(before, row.id);
  if (current.delivery === "rejected") return { repeat: true };
  if (current.runIds.length > 0) {
    throw new WorkRecordError("not_allowed", "A run is linked to this work order. Its end is the record, not a rejection.");
  }
  const claim = claimOf(before.facts, row.id);
  if (claim !== undefined && claim.kind === "claimed" && claim.data.host !== host.publicId) {
    throw new WorkRecordError("conflict", "Another runtime claimed this work order.");
  }
  const write = await appendFacts(tx, scope, {
    itemId: row.itemId,
    facts: [runtimeFact("send_rejected", row, host.publicId, now.toISOString(), `send_rejected:${row.id}`, { reason })],
  });
  return { repeat: write.repeat };
}

// ---------------------------------------------------------------------------
// Run link and end
// ---------------------------------------------------------------------------

/** A root session that names a work order on its first frame. */
export interface RunLinkInput {
  host: ClaimingHost;
  /** The session's public id (`tse_…`). */
  runId: string;
  /** The work order the session names (`wo_…`). */
  workOrder: string;
  at: Date;
}

/** What a link attempt did. */
export type RunLinkOutcome = "linked" | "repeat" | "not_claimed" | "already_linked" | "ended";

/**
 * Bind a run to the send it names, when the run's host is the host that
 * claimed the send. The first run to link wins: a later run that names the
 * same send is left unlinked, and the outcome says why. A stop that was asked
 * for before the run linked reaches the run now.
 */
export async function linkWorkOrderRun(tx: Tx, scope: WorkScope, input: RunLinkInput): Promise<RunLinkOutcome> {
  const row = await orderByPublicId(tx, scope, input.workOrder);
  assertTargetHost(row, input.host);
  const before = await readWorkItem(tx, scope, row.itemId);
  const current = orderOf(before, row.id);
  const claim = claimOf(before.facts, row.id);
  if (claim === undefined || claim.kind !== "claimed" || claim.data.host !== input.host.publicId) return "not_claimed";
  if (current.runIds.includes(input.runId)) return "repeat";
  if (current.runIds.length > 0) return "already_linked";
  if (current.closed) return "ended";
  const write = await appendFacts(tx, scope, {
    itemId: row.itemId,
    facts: [runtimeFact("run_linked", row, input.host.publicId, input.at.toISOString(), `run_linked:${row.id}`, {}, { runId: input.runId })],
  });
  const linked = orderOf(write, row.id);
  if (linked.delivery === "stopping") {
    const stop = write.facts.filter((fact) => fact.kind === "stop_requested" && fact.orderId === row.id).pop();
    await queueRunCancel(tx, scope, {
      workOrder: row.publicId,
      orderKey: row.key,
      runId: input.runId,
      reason: stop !== undefined && stop.kind === "stop_requested" ? stop.data.reason : "Stop requested before the run started.",
      userId: null,
    });
  }
  return write.repeat ? "repeat" : "linked";
}

/** The sends a run is linked to. */
async function sendsOfRun(tx: Tx, scope: WorkScope, runId: string): Promise<OrderRow[]> {
  const facts = schema.workItemFacts;
  const orders = schema.workOrders;
  const rows = await tx
    .selectDistinct({
      id: orders.id,
      publicId: orders.publicId,
      itemId: orders.itemId,
      key: orders.idempotencyKey,
      runtimeId: orders.runtimeId,
      agentId: orders.agentId,
    })
    .from(facts)
    .innerJoin(orders, eq(orders.id, facts.orderId))
    .where(
      and(
        eq(facts.orgId, scope.orgId),
        eq(facts.workspaceId, scope.workspaceId),
        eq(facts.kind, "run_linked"),
        eq(facts.runId, runId),
      ),
    );
  return rows.map((row) => ({ ...row, publicId: String(row.publicId) }));
}

/**
 * Record the end of a run on every send it is linked to. A repeat of the same
 * end changes nothing. Returns the number of sends that recorded it.
 */
export async function endWorkOrderRuns(tx: Tx, scope: WorkScope, runId: string, outcome: string | null, at: Date): Promise<number> {
  let recorded = 0;
  for (const order of await sendsOfRun(tx, scope, runId)) {
    const write = await appendFacts(tx, scope, {
      itemId: order.itemId,
      facts: [runtimeFact("run_ended", order, runId, at.toISOString(), `run_ended:${order.id}:${runId}`, { outcome }, { runId })],
    });
    if (!write.repeat) recorded += 1;
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// Command acknowledgements
// ---------------------------------------------------------------------------

/** A command row an acknowledgement just moved. */
export interface AckedCommand {
  publicId: string;
  command: string;
  outcome: string;
  payload: unknown;
}

function workOrderOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as { work_order?: unknown }).work_order;
  return typeof value === "string" && /^wo_[0-9a-z]+$/.test(value) ? value : null;
}

/**
 * The work facts a host's acknowledgements carry. A `work_order` command the
 * host took is `send_delivered`, with the command's id: the send reached the
 * runtime and waits for its claim. A stop's `cancel` the host applied is
 * `stopped`. Returns the number of facts recorded.
 */
export async function recordWorkOrderAcks(tx: Tx, scope: WorkScope, host: ClaimingHost, acked: readonly AckedCommand[], at: Date): Promise<number> {
  let recorded = 0;
  for (const command of acked) {
    const workOrder = workOrderOf(command.payload);
    if (workOrder === null) continue;
    const delivered = command.command === "work_order" && ["received", "acknowledged", "applied"].includes(command.outcome);
    const stopped = command.command === "cancel" && command.outcome === "applied";
    if (!delivered && !stopped) continue;
    const row = await orderByPublicId(tx, scope, workOrder);
    const fact = delivered
      ? { ...runtimeFact("send_delivered", row, "oxagen", at.toISOString(), `send_delivered:${row.id}`, { command_id: command.publicId }), source: "oxagen" as const }
      : runtimeFact("stopped", row, host.publicId, at.toISOString(), `stopped:${row.id}`, {});
    const write = await appendFacts(tx, scope, { itemId: row.itemId, facts: [fact] });
    if (!write.repeat) recorded += 1;
  }
  return recorded;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** The attribute a run started for a work order carries (WORK_OTLP_ATTRIBUTES.workOrderId). */
export const WORK_ORDER_RUN_ATTR = "oxagen.work_order.id";

/**
 * The work order a new run's frames name, or null. The host stamps the
 * attribute on the session's frames when `oxagen work start` launched it; a
 * daemon that re-keys a client's `oxagen.*` attribute writes it under
 * `client_claimed.`, which counts the same here, because the claim check in
 * `linkWorkOrderRun` is what makes it trustworthy. Pure.
 */
export function workOrderNamedBy(events: readonly { attrs?: Readonly<Record<string, string>> }[]): string | null {
  for (const event of events) {
    const value = event.attrs?.[WORK_ORDER_RUN_ATTR] ?? event.attrs?.[`client_claimed.${WORK_ORDER_RUN_ATTR}`];
    if (typeof value === "string" && /^wo_[0-9a-z]+$/.test(value)) return value;
  }
  return null;
}

/**
 * Link a run ingest just opened to the work order its frames name, in a
 * savepoint of the ingest transaction. A refusal (another host, an ended
 * send, a missing order) rolls back only the savepoint, and the caller logs
 * it: a run's events are recorded whatever its work order says.
 */
export async function linkRunFromIngest(
  tx: Tx,
  scope: WorkScope,
  host: ClaimingHost,
  runId: string,
  events: readonly { attrs?: Readonly<Record<string, string>> }[],
  at: Date,
): Promise<RunLinkOutcome | null> {
  const workOrder = workOrderNamedBy(events);
  if (workOrder === null) return null;
  return tx.transaction((savepoint) => linkWorkOrderRun(savepoint as Tx, scope, { host, runId, workOrder, at }));
}
