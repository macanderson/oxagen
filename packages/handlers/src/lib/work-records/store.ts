// store.ts: the one write path for the Phase 1 work records (P1-02, #4897).
//
// Every write locks the work item's row, reads its facts, and reduces them
// (@oxagen/work/records reduceWorkItem). A person's decision then has to name
// the item version it was made on (optimistic concurrency) and pass
// admitDecision, which refuses a stale revision, brief, or head. The store
// appends the facts, reduces again, and writes the projection: the item's
// state and revision, a version one higher, and each work order's release and
// close. So the stored state is always reduceWorkItem of the stored facts, and
// two writers on one item cannot both act on what they read.
//
// The caller opens the tenant transaction (withTenantDb inside
// runInTenantScope) and passes it in. Row security fences every read and
// write to the caller's org and workspace, and every query here also names
// them. The caller checks the actor's role first (workActionRoles). A work item
// grants no authority: the store records what was decided and checks the duty
// rules a send carries, and nothing more.
import { isUniqueViolation, schema, type Tx } from "@oxagen/database";
import type { Sha256Digest } from "@oxagen/run-evidence";
import {
  type BriefDraft,
  type FactDataByKind,
  type FactInput,
  type FactKind,
  type GovernanceMode,
  type RuntimeTier,
  type SourceMaterial,
  type WorkBrief,
  type WorkFact,
  type WorkItemDecision,
  type WorkItemProjection,
  type WorkItemPublicId,
  WorkRecordError,
  admitDecision,
  briefDigest,
  buildBrief,
  checkFact,
  checkSendDuties,
  isDecisionFactKind,
  isOrderFactKind,
  issuedCriterionIds,
  newFact,
  parseWorkBrief,
  reduceWorkItem,
  sourceDigest,
  workOrderKey,
} from "@oxagen/work/records";
import { and, asc, eq, sql } from "drizzle-orm";

const items = schema.workItems;
const briefs = schema.workBriefs;
const orders = schema.workOrders;
const facts = schema.workItemFacts;

/** The org and workspace a write belongs to. */
export interface WorkScope {
  orgId: string;
  workspaceId: string;
}

/** A work item as the store reads it. */
export interface WorkItemRecord {
  itemId: string;
  publicId: WorkItemPublicId;
  /** The concurrency token. A decision names it. */
  version: number;
  sourceDigest: Sha256Digest | null;
  sourceUrl: string | null;
  facts: WorkFact[];
  briefs: StoredBrief[];
  projection: WorkItemProjection;
}

/** One stored brief revision. */
export interface StoredBrief {
  briefId: string;
  publicId: string;
  revision: number;
  itemRevision: number;
  digest: Sha256Digest;
  brief: WorkBrief;
  author: string;
}

/** What a write did: the item after it, and whether it was a repeat that changed nothing. */
export interface WorkWrite extends WorkItemRecord {
  repeat: boolean;
}

/** Facts the store writes itself, through the operation named beside each. */
const STORE_OWNED_KINDS: Readonly<Partial<Record<FactKind, string>>> = {
  collected: "recordSource",
  entered: "recordSource",
  source_changed: "recordSource",
  brief_saved: "saveBrief",
  brief_approved: "approveBrief",
  send_requested: "openWorkOrder",
  reopened: "reopenWorkItem",
};

function notFound(): WorkRecordError {
  return new WorkRecordError("not_found", "This workspace has no such work item.");
}

function staleVersion(expected: number, actual: number): WorkRecordError {
  return new WorkRecordError(
    "stale_version",
    `You read version ${expected} of the work item, and it is now at version ${actual}. Read it again.`,
  );
}

function rowToFact(row: typeof facts.$inferSelect): WorkFact {
  return {
    kind: row.kind as FactKind,
    source: row.source as WorkFact["source"],
    itemRevision: row.itemRevision,
    orderId: row.orderId,
    briefId: row.briefId,
    briefDigest: row.briefDigest as Sha256Digest | null,
    repository: row.repository,
    prNumber: row.prNumber,
    headSha: row.headSha,
    runId: row.runId,
    criterionId: row.criterionId,
    actor: row.actor,
    occurredAt: row.occurredAt.toISOString(),
    dedupeKey: row.dedupeKey,
    data: row.data as FactDataByKind[FactKind],
  } as WorkFact;
}

interface LoadedItem extends WorkItemRecord {
  materialRevision: number;
}

/** Read one work item's record. With `lock`, hold its row until the transaction ends. */
async function load(tx: Tx, scope: WorkScope, itemId: string, lock: boolean): Promise<LoadedItem> {
  const query = tx
    .select({
      id: items.id,
      publicId: items.publicId,
      version: items.version,
      materialRevision: items.materialRevision,
      sourceDigest: items.sourceDigest,
      sourceUrl: items.sourceUrl,
    })
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId)));
  const [item] = lock ? await query.for("update") : await query;
  if (!item) throw notFound();

  const factRows = await tx
    .select()
    .from(facts)
    .where(and(eq(facts.itemId, itemId), eq(facts.orgId, scope.orgId), eq(facts.workspaceId, scope.workspaceId)))
    .orderBy(asc(facts.itemRevision), asc(facts.occurredAt), asc(facts.dedupeKey));
  const briefRows = await tx
    .select()
    .from(briefs)
    .where(and(eq(briefs.itemId, itemId), eq(briefs.orgId, scope.orgId), eq(briefs.workspaceId, scope.workspaceId)))
    .orderBy(asc(briefs.revision));

  const factList = factRows.map(rowToFact);
  return {
    itemId: item.id,
    publicId: item.publicId as WorkItemPublicId,
    version: item.version,
    materialRevision: item.materialRevision,
    sourceDigest: item.sourceDigest as Sha256Digest | null,
    sourceUrl: item.sourceUrl,
    facts: factList,
    briefs: briefRows.map((row) => ({
      briefId: row.id,
      publicId: row.publicId,
      revision: row.revision,
      itemRevision: row.itemRevision,
      digest: row.digest as Sha256Digest,
      brief: parseWorkBrief(row.body),
      author: row.author,
    })),
    projection: reduceWorkItem(factList),
  };
}

/** Read a work item's record and its reduced state. Takes no lock. */
export async function readWorkItem(tx: Tx, scope: WorkScope, itemId: string): Promise<WorkItemRecord> {
  const { materialRevision: _revision, ...record } = await load(tx, scope, itemId, false);
  return record;
}

/**
 * The database's clock, read after the row lock, for the facts a person
 * records. One clock for every writer keeps a person's decisions in the order
 * the lock admitted them.
 */
async function clock(tx: Tx): Promise<string> {
  const [row] = await tx.execute<{ now: string }>(
    sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`,
  );
  if (!row) throw new Error("The database returned no time.");
  return row.now;
}

/** A row for work.item_facts. */
function factRow(scope: WorkScope, itemId: string, fact: WorkFact, createdById: string | null): typeof facts.$inferInsert {
  return {
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    createdById,
    itemId,
    orderId: fact.orderId,
    kind: fact.kind,
    source: fact.source,
    itemRevision: fact.itemRevision,
    briefId: fact.briefId,
    briefDigest: fact.briefDigest,
    repository: fact.repository,
    prNumber: fact.prNumber,
    headSha: fact.headSha,
    runId: fact.runId,
    criterionId: fact.criterionId,
    actor: fact.actor,
    data: fact.data as Record<string, unknown>,
    occurredAt: new Date(fact.occurredAt),
    dedupeKey: fact.dedupeKey,
  };
}

/** Insert facts. A fact whose dedupe key the item already holds is skipped. Returns the facts that were new. */
async function insertFacts(tx: Tx, scope: WorkScope, itemId: string, list: WorkFact[], createdById: string | null): Promise<WorkFact[]> {
  const inserted: WorkFact[] = [];
  for (const fact of list) {
    checkFact(fact);
    const rows = await tx
      .insert(facts)
      .values(factRow(scope, itemId, fact, createdById))
      .onConflictDoNothing({ target: [facts.itemId, facts.dedupeKey] })
      .returning({ id: facts.id });
    if (rows.length > 0) inserted.push(fact);
  }
  return inserted;
}

/**
 * Write the projection of the item's facts: state, revision, a version one
 * higher, and each order's release and close. Returns the record after it.
 */
async function persist(
  tx: Tx,
  scope: WorkScope,
  loaded: LoadedItem,
  added: WorkFact[],
  extra: { sourceDigest?: Sha256Digest; actorId?: string | null } = {},
): Promise<WorkWrite> {
  if (added.length === 0) return { ...loaded, repeat: true };
  const all = [...loaded.facts, ...added];
  const projection = reduceWorkItem(all);
  const version = loaded.version + 1;
  const updated = await tx
    .update(items)
    .set({
      state: projection.state,
      materialRevision: projection.revision,
      version,
      ...(extra.sourceDigest ? { sourceDigest: extra.sourceDigest } : {}),
      updatedAt: sql`now()`,
      updatedById: extra.actorId ?? null,
    })
    .where(and(eq(items.id, loaded.itemId), eq(items.version, loaded.version)))
    .returning({ id: items.id });
  // The row is locked, so this holds unless a writer bypassed the store.
  if (updated.length !== 1) throw new WorkRecordError("stale_version", "The work item changed while this write ran. Read it again.");

  for (const order of projection.orders) {
    if (order.released) {
      await tx
        .update(orders)
        .set({ releasedAt: sql`now()` })
        .where(and(eq(orders.id, order.orderId), sql`${orders.releasedAt} IS NULL`));
    }
    if (order.closed) {
      await tx
        .update(orders)
        .set({ closedAt: sql`now()` })
        .where(and(eq(orders.id, order.orderId), sql`${orders.closedAt} IS NULL`));
    }
  }
  return {
    ...loaded,
    version,
    sourceDigest: extra.sourceDigest ?? loaded.sourceDigest,
    facts: all,
    projection,
    repeat: false,
  };
}

function requireVersion(loaded: LoadedItem, expectedVersion: number): void {
  if (loaded.version !== expectedVersion) throw staleVersion(expectedVersion, loaded.version);
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** A source reading: what the provider or the person entering the item says it holds now. */
export interface RecordSourceInput {
  itemId: string;
  material: SourceMaterial;
  /** `provider` for a collector, `person` for an item entered in Oxagen. */
  source: "provider" | "person";
  actor: string;
  /** The provider's own update time. */
  occurredAt: string;
  /** The provider delivery or reconcile that carried it, so a repeat is a no-op. */
  dedupeKey: string;
  /** The user id, for an item a person entered. */
  actorUserId?: string | null;
}

/**
 * Record the source's material fields. The first reading is revision 1. A
 * later reading with a different digest moves the item to the next revision.
 * The same digest changes nothing, so a touch that changes no subject,
 * description, or label is a no-op.
 */
export async function recordSource(tx: Tx, scope: WorkScope, input: RecordSourceInput): Promise<WorkWrite> {
  const loaded = await load(tx, scope, input.itemId, true);
  const digest = sourceDigest(input.material);
  if (loaded.sourceDigest === digest) return { ...loaded, repeat: true };
  const snapshot = {
    digest,
    subject: input.material.subject,
    description: input.material.description,
    labels: [...input.material.labels],
  };
  const first = loaded.sourceDigest === null && loaded.projection.source === null;
  const base = { source: input.source, actor: input.actor, occurredAt: input.occurredAt, dedupeKey: input.dedupeKey };
  const fact: WorkFact = first
    ? input.source === "provider"
      ? newFact({ kind: "collected", ...base, itemRevision: loaded.materialRevision, data: snapshot })
      : newFact({ kind: "entered", ...base, itemRevision: loaded.materialRevision, data: snapshot })
    : newFact({
        kind: "source_changed",
        ...base,
        itemRevision: loaded.materialRevision + 1,
        data: { ...snapshot, previous_digest: loaded.sourceDigest },
      });
  const added = await insertFacts(tx, scope, loaded.itemId, [fact], input.actorUserId ?? null);
  return persist(tx, scope, loaded, added, { sourceDigest: digest, actorId: input.actorUserId ?? null });
}

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

/** A person's or triage's edit of the brief. */
export interface SaveBriefInput {
  itemId: string;
  expectedVersion: number;
  /** The item revision the editor read. */
  itemRevision: number;
  draft: BriefDraft;
  /** A user id, or `triage`. */
  actor: string;
  source: "person" | "oxagen";
  actorUserId?: string | null;
}

/**
 * Save a new brief revision. Existing criteria keep their ids, and new ones
 * take the next unused numbers. Editing an approved brief is a material
 * change: the item moves to its next revision and leaves ready.
 */
export async function saveBrief(tx: Tx, scope: WorkScope, input: SaveBriefInput): Promise<WorkWrite> {
  const loaded = await load(tx, scope, input.itemId, true);
  requireVersion(loaded, input.expectedVersion);
  admitDecision(loaded.projection, { kind: "save_brief", itemRevision: input.itemRevision });
  const revises = loaded.projection.approvedBrief !== null;
  const itemRevision = revises ? loaded.projection.revision + 1 : loaded.projection.revision;
  const revision = (loaded.projection.latestBrief?.revision ?? 0) + 1;
  const brief = buildBrief({
    item: loaded.publicId,
    itemRevision,
    source: { url: loaded.sourceUrl, digest: loaded.sourceDigest },
    draft: input.draft,
    issuedIds: issuedCriterionIds(loaded.briefs.map((stored) => stored.brief)),
  });
  const digest = briefDigest(brief);
  const [row] = await tx
    .insert(briefs)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      createdById: input.actorUserId ?? null,
      itemId: loaded.itemId,
      revision,
      itemRevision,
      body: brief as unknown as Record<string, unknown>,
      digest,
      author: input.actor,
    })
    .returning({ id: briefs.id, publicId: briefs.publicId });
  const withBrief: LoadedItem = {
    ...loaded,
    briefs: [...loaded.briefs, { briefId: row!.id, publicId: row!.publicId, revision, itemRevision, digest, brief, author: input.actor }],
  };
  const occurredAt = await clock(tx);
  const fact = newFact({
    kind: "brief_saved",
    source: input.source,
    itemRevision,
    actor: input.actor,
    occurredAt,
    dedupeKey: `brief_saved:${revision}`,
    briefId: row!.id,
    briefDigest: digest,
    data: { revision, revises },
  });
  const added = await insertFacts(tx, scope, loaded.itemId, [fact], input.actorUserId ?? null);
  return persist(tx, scope, withBrief, added, { actorId: input.actorUserId ?? null });
}

/** A person's approval of one brief revision. */
export interface ApproveBriefInput {
  itemId: string;
  expectedVersion: number;
  itemRevision: number;
  briefRevision: number;
  briefDigest: Sha256Digest;
  actorUserId: string;
}

/** Approve the latest brief revision for the current item revision. A repeat changes nothing. */
export async function approveBrief(tx: Tx, scope: WorkScope, input: ApproveBriefInput): Promise<WorkWrite> {
  const loaded = await load(tx, scope, input.itemId, true);
  const decision: WorkItemDecision = {
    kind: "approve_brief",
    itemRevision: input.itemRevision,
    briefRevision: input.briefRevision,
    briefDigest: input.briefDigest,
  };
  // An approval already recorded as asked is a repeat whatever the version.
  if (admitIfRepeat(loaded, decision)) return { ...loaded, repeat: true };
  requireVersion(loaded, input.expectedVersion);
  admitDecision(loaded.projection, decision);
  const stored = loaded.briefs.find((entry) => entry.revision === input.briefRevision);
  if (!stored) throw new WorkRecordError("stale_brief", "That brief revision does not exist. Read the item again.");
  const fact = newFact({
    kind: "brief_approved",
    source: "person",
    itemRevision: loaded.projection.revision,
    actor: input.actorUserId,
    occurredAt: await clock(tx),
    dedupeKey: `brief_approved:${loaded.projection.revision}`,
    briefId: stored.briefId,
    briefDigest: stored.digest,
    data: { revision: stored.revision },
  });
  const added = await insertFacts(tx, scope, loaded.itemId, [fact], input.actorUserId);
  return persist(tx, scope, loaded, added, { actorId: input.actorUserId });
}

/** True when the decision is admitted as a repeat. A refusal here is left for the full check. */
function admitIfRepeat(loaded: LoadedItem, decision: WorkItemDecision): boolean {
  try {
    return admitDecision(loaded.projection, decision).repeat;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Work order
// ---------------------------------------------------------------------------

/** A person's send of the approved brief to one agent on one runtime. */
export interface OpenWorkOrderInput {
  itemId: string;
  expectedVersion: number;
  itemRevision: number;
  briefRevision: number;
  briefDigest: Sha256Digest;
  /** `<item>:r<brief revision>:s<send>`, fixed by the caller before it sends. */
  idempotencyKey: string;
  agentId: string;
  runtimeId: string;
  runtimeTier: RuntimeTier;
  mandateId: string | null;
  budgetReservationId: string | null;
  /** The person sending. */
  operatorId: string;
  /** The workspace's governance mode. A regulated workspace keeps the approver from sending. */
  governanceMode: GovernanceMode;
  /** Whether the person operates the target agent. The caller reads it from the agent registry. */
  operatesAgent: boolean;
}

/** The send a write opened. */
export interface WorkOrderWrite extends WorkWrite {
  orderId: string;
  orderPublicId: string;
  send: number;
}

/**
 * Open a work order for the approved brief. A retry with the same key returns
 * the order it opened. The database holds one open order per item and one
 * unreleased order per agent, so a second send to a busy agent is refused.
 */
export async function openWorkOrder(tx: Tx, scope: WorkScope, input: OpenWorkOrderInput): Promise<WorkOrderWrite> {
  const loaded = await load(tx, scope, input.itemId, true);
  const [existing] = await tx
    .select({
      id: orders.id,
      publicId: orders.publicId,
      itemId: orders.itemId,
      send: orders.send,
      agentId: orders.agentId,
      runtimeId: orders.runtimeId,
      briefDigest: orders.briefDigest,
    })
    .from(orders)
    .where(
      and(eq(orders.orgId, scope.orgId), eq(orders.workspaceId, scope.workspaceId), eq(orders.idempotencyKey, input.idempotencyKey)),
    );
  if (existing) {
    const same =
      existing.itemId === loaded.itemId &&
      existing.agentId === input.agentId &&
      existing.runtimeId === input.runtimeId &&
      existing.briefDigest === input.briefDigest;
    if (!same) {
      throw new WorkRecordError("conflict", `The key ${input.idempotencyKey} already names a different send. Read the item again.`);
    }
    return { ...loaded, repeat: true, orderId: existing.id, orderPublicId: existing.publicId, send: existing.send };
  }

  requireVersion(loaded, input.expectedVersion);
  admitDecision(loaded.projection, {
    kind: "send",
    item: loaded.publicId,
    itemRevision: input.itemRevision,
    briefRevision: input.briefRevision,
    briefDigest: input.briefDigest,
    key: input.idempotencyKey,
  });
  const approved = loaded.projection.approvedBrief!;
  checkSendDuties({
    actorId: input.operatorId,
    approverId: approved.actor,
    governanceMode: input.governanceMode,
    operatesAgent: input.operatesAgent,
  });
  const stored = loaded.briefs.find((entry) => entry.briefId === approved.briefId)!;
  const send = loaded.projection.nextSend;

  let orderId: string;
  let orderPublicId: string;
  try {
    const [row] = await tx
      .insert(orders)
      .values({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        createdById: input.operatorId,
        itemId: loaded.itemId,
        itemRevision: loaded.projection.revision,
        send,
        briefId: stored.briefId,
        briefRevision: stored.revision,
        briefDigest: stored.digest,
        idempotencyKey: workOrderKey(loaded.publicId, stored.revision, send),
        agentId: input.agentId,
        runtimeId: input.runtimeId,
        runtimeTier: input.runtimeTier,
        operatorId: input.operatorId,
        mandateId: input.mandateId,
        repository: stored.brief.repository,
        budgetReservationId: input.budgetReservationId,
      })
      .returning({ id: orders.id, publicId: orders.publicId });
    orderId = row!.id;
    orderPublicId = row!.publicId;
  } catch (error) {
    if (isUniqueViolation(error, "orders_open_agent_uniq")) {
      throw new WorkRecordError("conflict", "The agent already has a send out. Wait for its run to end, or send to another agent.");
    }
    if (isUniqueViolation(error)) {
      throw new WorkRecordError("conflict", "Another send of this item started at the same time. Read the item again.");
    }
    throw error;
  }

  const fact = newFact({
    kind: "send_requested",
    source: "person",
    itemRevision: loaded.projection.revision,
    actor: input.operatorId,
    occurredAt: await clock(tx),
    dedupeKey: `send_requested:${send}`,
    orderId,
    briefId: stored.briefId,
    briefDigest: stored.digest,
    data: {
      send,
      brief_revision: stored.revision,
      key: input.idempotencyKey,
      agent_id: input.agentId,
      runtime_id: input.runtimeId,
      runtime_tier: input.runtimeTier,
      operator_id: input.operatorId,
    },
  });
  const added = await insertFacts(tx, scope, loaded.itemId, [fact], input.operatorId);
  const written = await persist(tx, scope, loaded, added, { actorId: input.operatorId });
  return { ...written, orderId, orderPublicId, send };
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** Facts to append. A person's decision names the version it was made on. */
export interface AppendFactsInput {
  itemId: string;
  facts: FactInput<FactKind>[];
  /** Required when any fact is a person's decision. */
  expectedVersion?: number;
  /** The user id behind a person's decision. */
  actorUserId?: string | null;
}

/**
 * The criterion ids of the approved brief an acceptance is checked against.
 * With no approval the review gate refuses the acceptance, so the list is
 * empty. An approval whose brief is not loaded is refused: an empty list would
 * let an acceptance with no ticks through. Pure.
 */
export function approvedCriteriaOf(record: Pick<WorkItemRecord, "projection" | "briefs">): string[] {
  const approved = record.projection.approvedBrief;
  if (approved === null) return [];
  const stored = record.briefs.find((entry) => entry.briefId === approved.briefId);
  if (stored === undefined) throw new WorkRecordError("not_found", "The approved brief is missing. Read the item again.");
  return stored.brief.criteria.map((criterion) => criterion.id);
}

function decisionOf(loaded: LoadedItem, fact: WorkFact): WorkItemDecision | null {
  switch (fact.kind) {
    case "triage_overridden":
      return { kind: "override_triage" };
    case "closed":
      return { kind: "close" };
    case "send_withdrawn":
      return { kind: "withdraw", orderId: fact.orderId as string };
    case "stop_requested":
      return { kind: "stop", orderId: fact.orderId as string };
    case "returned":
      return { kind: "return", orderId: fact.orderId as string };
    case "accepted":
      return {
        kind: "accept",
        orderId: fact.orderId as string,
        headSha: fact.headSha as string,
        briefDigest: fact.briefDigest as Sha256Digest,
        criteria: fact.data.criteria,
        briefCriteria: approvedCriteriaOf(loaded),
      };
    default:
      return null;
  }
}

/**
 * Append facts from a provider, a runtime, an agent, Oxagen, or a person. The
 * store writes the brief, send, source, and reopen facts itself, so those
 * kinds are refused here. An order's facts take the order's item revision. A
 * person's decision must name the current version and pass admitDecision, and
 * takes the database's clock and a version-bound dedupe key. A fact the item
 * already holds is a repeat.
 */
export async function appendFacts(tx: Tx, scope: WorkScope, input: AppendFactsInput): Promise<WorkWrite> {
  const loaded = await load(tx, scope, input.itemId, true);
  const byOrder = new Map(loaded.projection.orders.map((order) => [order.orderId, order]));
  const recorded = new Set(loaded.facts.map((fact) => fact.dedupeKey));
  const list: WorkFact[] = [];
  let decided = false;
  for (const raw of input.facts) {
    const owner = STORE_OWNED_KINDS[raw.kind];
    if (owner !== undefined) {
      throw new WorkRecordError("invalid_input", `A ${raw.kind} fact is written by ${owner}, not appended.`);
    }
    // A repeat delivery of a fact the item holds changes nothing, whatever
    // has happened since.
    if (!isDecisionFactKind(raw.kind) && recorded.has(raw.dedupeKey)) continue;
    let fact = newFact(raw) as WorkFact;
    if (isOrderFactKind(fact.kind)) {
      const order = fact.orderId === null ? undefined : byOrder.get(fact.orderId);
      if (order === undefined) throw new WorkRecordError("not_found", "This work item has no such send.");
      // The claim is the runtime's handshake before it starts. A send that
      // has ended can never be claimed, so the runtime must not start it.
      if (fact.kind === "claimed" && order.closed) {
        throw new WorkRecordError("not_allowed", `Send ${order.send} has ended (${order.delivery}). The runtime must not start it.`);
      }
      fact = { ...fact, itemRevision: order.itemRevision };
    }
    if (isDecisionFactKind(fact.kind)) {
      if (fact.source !== "person") throw new WorkRecordError("invalid_input", `A ${fact.kind} fact is a person's decision.`);
      const decision = decisionOf(loaded, fact);
      if (decision !== null && admitIfRepeat(loaded, decision)) continue;
      if (input.expectedVersion === undefined) {
        throw new WorkRecordError("invalid_input", `A ${fact.kind} fact must name the item version it was decided on.`);
      }
      requireVersion(loaded, input.expectedVersion);
      if (decision !== null) admitDecision(loaded.projection, decision);
      if (fact.kind === "accepted") {
        // Record the required checks the gate evaluated on this head, never a
        // list the caller sent: the acceptance is evidence of what was checked.
        // Name the approved brief admitDecision matched the digest against, so
        // the fact's brief foreign key binds the acceptance to that revision.
        // Bind it to the pull request and the runs it judged too (Data
        // contract): admitDecision passed the gate, so the send has a pull
        // request, and checkFact refuses an acceptance without one.
        const order = byOrder.get(fact.orderId as string);
        fact = {
          ...fact,
          briefId: loaded.projection.approvedBrief?.briefId ?? null,
          repository: order?.pullRequest?.repository ?? null,
          prNumber: order?.pullRequest?.number ?? null,
          data: { ...fact.data, required_checks: [...(order?.requiredChecks ?? [])], run_ids: [...(order?.runIds ?? [])] },
        };
      } else if (fact.kind === "returned") {
        // Bind a return to what it rejected: the pull request, its head, and
        // the runs, when the send has them.
        const order = byOrder.get(fact.orderId as string);
        fact = {
          ...fact,
          repository: order?.pullRequest?.repository ?? null,
          prNumber: order?.pullRequest?.number ?? null,
          headSha: order?.head ?? null,
          data: { ...fact.data, run_ids: [...(order?.runIds ?? [])] },
        };
      }
      const occurredAt = await clock(tx);
      fact = {
        ...fact,
        occurredAt,
        dedupeKey: `${fact.kind}:v${loaded.version + 1}`,
        ...(isOrderFactKind(fact.kind) ? {} : { itemRevision: loaded.projection.revision }),
      } as WorkFact;
      decided = true;
    } else if (!isOrderFactKind(fact.kind) && fact.itemRevision > loaded.projection.revision) {
      throw new WorkRecordError("stale_revision", `The item is at revision ${loaded.projection.revision}, and the fact names ${fact.itemRevision}.`);
    }
    list.push(fact);
  }
  if (decided && list.filter((fact) => isDecisionFactKind(fact.kind)).length > 1) {
    throw new WorkRecordError("invalid_input", "Append one decision at a time.");
  }
  const added = await insertFacts(tx, scope, loaded.itemId, list, input.actorUserId ?? null);
  return persist(tx, scope, loaded, added, { actorId: input.actorUserId ?? null });
}

/** A person's reopen of a closed or done item. */
export interface ReopenInput {
  itemId: string;
  expectedVersion: number;
  reason: string;
  actorUserId: string;
}

/**
 * Reopen a closed or done item. Every earlier fact stays. The item moves to
 * its next revision, the brief goes back to a draft, and the next send is a
 * fresh delivery.
 */
export async function reopenWorkItem(tx: Tx, scope: WorkScope, input: ReopenInput): Promise<WorkWrite> {
  const loaded = await load(tx, scope, input.itemId, true);
  requireVersion(loaded, input.expectedVersion);
  admitDecision(loaded.projection, { kind: "reopen" });
  const fact = newFact({
    kind: "reopened",
    source: "person",
    itemRevision: loaded.projection.revision + 1,
    actor: input.actorUserId,
    occurredAt: await clock(tx),
    dedupeKey: `reopened:v${loaded.version + 1}`,
    data: { reason: input.reason, after_send: loaded.projection.nextSend - 1 },
  });
  const added = await insertFacts(tx, scope, loaded.itemId, [fact], input.actorUserId);
  return persist(tx, scope, loaded, added, { actorId: input.actorUserId });
}
