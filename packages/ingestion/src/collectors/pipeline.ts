// collectors/pipeline.ts: the path every collector shares, from a delivery to
// a stored work item (agent-work-spec.html, Collectors).
//
// 1. receiveDelivery: verify, store the body as a work.inbound_events row
//    keyed by the delivery id, keep the raw bytes in object storage by
//    SHA-256. The route answers 202 and emits work/event.received.
// 2. openInboundEvent and collectRef: read the stored event, ask the module's
//    doorbell for the item ids, fetch each item by id, map it with toWorkItem,
//    and upsert it on the collector and the provider id. The worker emits
//    work/item.received for a new item or a changed subject, description, or
//    label set.
// 3. reconcilePage and finishReconcile: read what changed since the cursor,
//    count what the doorbell missed, and set the collector's health.
// 4. nightlyCount: compare the provider's open items with Oxagen's.
//
// Everything here runs over ports, so the same code runs against Postgres in
// the workers and against memory in tests. The ports are bound to one org and
// workspace. Nothing here emits an event: each function returns what happened
// and the caller emits.
//
// Every subject, description, and requester is outside text. It is data. This
// file marks it tainted and screens it before the store sees it, and never
// hands it to a model.
import { createHash } from "node:crypto";
import {
  COLLECTOR_COUNT_TYPE,
  COLLECTOR_RECONCILE_TYPE,
  type CollectorCloudEvent,
  bodyDigest,
  deliveryCloudEvent,
  requestFromCloudEvent,
  resultCloudEvent,
} from "./cloudevent";
import { type CollectorHealth, healthOf } from "./health";
import { type AnyCollectorDefinition, getCollector } from "./registry";
import type {
  CollectorType,
  Connection,
  InboundRequest,
  ItemRef,
  ProviderItem,
  Secret,
  TaintedField,
  WorkItemInput,
} from "./types";

// ── Records ─────────────────────────────────────────────────────────────────
// Plain JSON, so a durable step can return any of them. Times are RFC 3339.

/** One work.collectors row. */
export interface CollectorRecord {
  id: string;
  orgId: string;
  workspaceId: string;
  name: string;
  type: CollectorType;
  /** The source connection row. Null for email, and for a file whose connection did not resolve. */
  connectionId: string | null;
  /** The file's [scope] table. */
  scope: Record<string, unknown>;
  health: CollectorHealth;
  cursor: string | null;
  /** When the row was created. The doorbell cannot have missed a change older than this. */
  createdAt: string;
}

/** One work.inbound_events row. */
export interface InboundEventRecord {
  id: string;
  collectorId: string;
  deliveryId: string;
  cloudevent: CollectorCloudEvent;
  rawRef: string | null;
  processedAt: string | null;
  outcome: string | null;
  createdAt: string;
}

/** A row to insert into work.inbound_events. */
export interface NewInboundEvent {
  collectorId: string;
  deliveryId: string;
  cloudevent: CollectorCloudEvent;
  rawRef: string | null;
  /** Set for a result row, which is stored already processed. */
  processedAt: string | null;
  outcome: string | null;
}

/** The work.items fields the pipeline compares. */
export interface StoredWorkItem {
  id: string;
  /** The `wi_` public id work/ events carry. */
  publicId: string;
  subject: string;
  description: string | null;
  labels: string[];
  sourceUpdatedAt: string | null;
  /** True for a soft-deleted item. Oxagen keeps it current and emits nothing for it. */
  deleted: boolean;
}

// ── Outcomes ────────────────────────────────────────────────────────────────

/** What work.inbound_events.outcome records. */
export const INBOUND_OUTCOMES = {
  /** The doorbell named items and each one was fetched and stored. */
  collected: "collected",
  /** The doorbell named no items, such as a ping or an event on another kind of record. */
  noItems: "no_items",
  /** The module's doorbell threw on the stored body. */
  doorbellFailed: "doorbell_failed",
  /** The collector's [scope] no longer passes the module's config schema. */
  scopeInvalid: "scope_invalid",
  /** A reconcile read every page. */
  reconciled: "reconciled",
  /** A reconcile could not authenticate, list, or fetch. */
  reconcileFailed: "reconcile_failed",
  countMatched: "count_matched",
  countDiffered: "count_differed",
  /** The nightly count could not finish. It changes no health. */
  countFailed: "count_failed",
} as const;

/** The delivery id prefix of a reconcile's result row. */
export const RECONCILE_KEY_PREFIX = "reconcile:";

/** The delivery id prefix of a nightly count's result row. */
export const COUNT_KEY_PREFIX = "count:";

/**
 * How old a change must be before a reconcile counts it as missed. A change
 * younger than this may still be on its way through the doorbell.
 */
export const MISSED_GRACE_MS = 5 * 60 * 1000;

/** Result rows read to work out the failed streak. */
const HEALTH_WINDOW = 3;

// ── Ports ───────────────────────────────────────────────────────────────────

/** The storage the pipeline reads and writes, bound to one org and workspace. */
export interface CollectorStore {
  getCollector(id: string): Promise<CollectorRecord | null>;
  /** True when this collector already stored this delivery id. */
  hasDelivery(collectorId: string, deliveryId: string): Promise<boolean>;
  /** Insert one row. Null when (collector_id, delivery_id) already exists. */
  insertInboundEvent(row: NewInboundEvent): Promise<InboundEventRecord | null>;
  getInboundEvent(id: string): Promise<InboundEventRecord | null>;
  /** Set processed_at to now and record the outcome. */
  markInboundEvent(id: string, outcome: string): Promise<void>;
  /**
   * The workspace's item for this provider id, soft-deleted or not. One
   * provider item is one work item in a workspace, whichever collector heard
   * it (ADR-244), so a store bound to one workspace matches on the provider id
   * alone. The collector id names the caller.
   */
  findItem(collectorId: string, providerId: string): Promise<StoredWorkItem | null>;
  /**
   * Insert or update the workspace's item for this provider id. A new item
   * gets the workspace's next number. The input is already screened.
   */
  upsertItem(
    collector: CollectorRecord,
    input: WorkItemInput,
  ): Promise<{ item: StoredWorkItem; created: boolean }>;
  setCursor(collectorId: string, cursor: string): Promise<void>;
  setHealth(collectorId: string, health: CollectorHealth): Promise<void>;
  /** A collector's reconcile or count result rows, newest first. */
  listResults(
    collectorId: string,
    kind: "reconcile" | "count",
    limit: number,
  ): Promise<InboundEventRecord[]>;
  /** The collector's work items that are not closed and not deleted. */
  countOpenItems(collectorId: string): Promise<number>;
}

export interface CollectorPorts {
  store: CollectorStore;
  /** The sensitive-data screen. Returns the value with every finding redacted. */
  screen<T>(value: T): Promise<{ value: T; redactions: number }>;
  /**
   * Keep the raw bytes in private object storage, and return the stored key.
   * Optional: a deployment that keeps no unscreened bytes leaves it out, and
   * the row's raw_ref stays null.
   */
  putRaw?(key: string, body: Uint8Array, contentType: string): Promise<string>;
  /** The collector's connection with its credential. Throws when none is usable. */
  connection(collector: CollectorRecord): Promise<Connection>;
  now(): Date;
  /** The module for a type. Defaults to the registry. */
  collectorFor?(type: CollectorType): AnyCollectorDefinition | undefined;
}

function moduleFor(
  ports: CollectorPorts,
  type: CollectorType,
): AnyCollectorDefinition | undefined {
  return ports.collectorFor ? ports.collectorFor(type) : getCollector(type);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── 1. Doorbell ─────────────────────────────────────────────────────────────

export type DeliveryResult =
  | { kind: "no_module" }
  | { kind: "rejected"; reason: string }
  | { kind: "duplicate"; deliveryId: string }
  | {
      kind: "stored";
      inboundEventId: string;
      deliveryId: string;
      /** True when the collector is paused: the row is stored and nothing is emitted. */
      paused: boolean;
    };

/** The object storage key for a raw body: `work/inbound/<org>/<sha256 hex>`. */
export function rawBodyKey(orgId: string, body: Uint8Array): string {
  const hex = bodyDigest(body).slice("sha256:".length);
  return `work/inbound/${orgId}/${hex}`;
}

/**
 * Screen what a stored envelope carries. deliveryCloudEvent sets exactly one
 * of data and data_base64: the text inside data_base64 is screened as text,
 * and anything else as the JSON data.
 */
async function screenEnvelope(
  ports: CollectorPorts,
  event: CollectorCloudEvent,
): Promise<CollectorCloudEvent> {
  if (event.data_base64 !== undefined) {
    const text = Buffer.from(event.data_base64, "base64").toString("utf8");
    const { value, redactions } = await ports.screen(text);
    if (redactions === 0) return event;
    return { ...event, data_base64: Buffer.from(value, "utf8").toString("base64") };
  }
  const { value } = await ports.screen(event.data);
  return { ...event, data: value };
}

/** The request with every header name in lowercase, as modules read them. */
export function withLowercaseHeaders(request: InboundRequest): InboundRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers))
    headers[name.toLowerCase()] = value;
  return { ...request, headers };
}

/**
 * The doorbell's write. It verifies the delivery against the collector's
 * secret, and a repeated delivery id writes nothing: no object, no row.
 */
export async function receiveDelivery(
  ports: CollectorPorts,
  args: { collector: CollectorRecord; request: InboundRequest; secret: Secret },
): Promise<DeliveryResult> {
  const { collector, secret } = args;
  const request = withLowercaseHeaders(args.request);
  const definition = moduleFor(ports, collector.type);
  if (!definition) return { kind: "no_module" };
  const verified = definition.verify(request, secret);
  if (!verified.ok) return { kind: "rejected", reason: verified.reason };
  const { deliveryId } = verified;
  if (await ports.store.hasDelivery(collector.id, deliveryId))
    return { kind: "duplicate", deliveryId };
  const contentType = request.headers["content-type"] ?? "application/octet-stream";
  const rawRef = ports.putRaw
    ? await ports.putRaw(rawBodyKey(collector.orgId, request.body), request.body, contentType)
    : null;
  const cloudevent = await screenEnvelope(
    ports,
    deliveryCloudEvent({ collectorId: collector.id, deliveryId, request }),
  );
  const row = await ports.store.insertInboundEvent({
    collectorId: collector.id,
    deliveryId,
    cloudevent,
    rawRef,
    processedAt: null,
    outcome: null,
  });
  // A second delivery raced this one between the check and the insert.
  if (!row) return { kind: "duplicate", deliveryId };
  return {
    kind: "stored",
    inboundEventId: row.id,
    deliveryId,
    paused: collector.health === "paused",
  };
}

// ── 2. Fetch and map ────────────────────────────────────────────────────────

export type ItemChangeKind = "new" | "updated";

/** One upsert that work/item.received reports. */
export interface ItemChange {
  /** The `wi_` public id. */
  publicId: string;
  change: ItemChangeKind;
  /** Short digest of the fields the change covers, for the event's idempotency key. */
  digest: string;
}

export interface CollectResult {
  providerId: string;
  /** Null when nothing a work/item.received reader cares about changed. */
  change: ItemChange | null;
  /** The stored item before this write. Null when the item is new. */
  before: StoredWorkItem | null;
  /** True when the stored item is newer than the one fetched, so nothing was written. */
  stale: boolean;
  /** True when the record is outside the collector's scope, so nothing was written. */
  skipped: boolean;
}

/**
 * The digest covers the provider's update time as well as the fields, so a
 * subject changed from A to B and back to A gives three keys, not two.
 */
function changeDigest(input: {
  subject: string;
  description: string | null;
  labels: string[];
  sourceUpdatedAt: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.subject,
        input.description,
        [...input.labels].sort(),
        input.sourceUpdatedAt,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

function sameLabels(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((label, i) => label === right[i]);
}

function isNewer(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  return Date.parse(a) > Date.parse(b);
}

/**
 * The fields that came from outside the workspace. The subject always does,
 * and the description and requester do whenever they are present. A module
 * can mark more, never fewer.
 */
export function taintedFields(input: WorkItemInput): TaintedField[] {
  const fields = new Set<TaintedField>(input.tainted);
  fields.add("subject");
  if (input.description !== null) fields.add("description");
  if (input.requester !== null) fields.add("requester");
  const order: TaintedField[] = ["subject", "description", "requester"];
  return order.filter((field) => fields.has(field));
}

/**
 * Map one fetched item and upsert it. The subject, description, and requester
 * pass through the screen before the store sees them. An item the store holds
 * a newer copy of is left alone, because a late delivery must not undo a
 * later change.
 */
export async function collectItem(
  ports: CollectorPorts,
  collector: CollectorRecord,
  definition: AnyCollectorDefinition,
  config: unknown,
  item: ProviderItem,
): Promise<CollectResult> {
  const mapped = definition.toWorkItem(item, config);
  // Null: the record is outside the collector's configured scope. It is
  // skipped, and no work item is written for it.
  if (mapped === null)
    return {
      providerId: item.ref.providerId,
      change: null,
      before: null,
      stale: false,
      skipped: true,
    };
  const before = await ports.store.findItem(collector.id, mapped.providerId);
  if (before && isNewer(before.sourceUpdatedAt, mapped.sourceUpdatedAt))
    return { providerId: mapped.providerId, change: null, before, stale: true, skipped: false };
  const { value: screened } = await ports.screen({
    subject: mapped.subject,
    description: mapped.description,
    requester: mapped.requester,
  });
  const input: WorkItemInput = {
    ...mapped,
    subject: screened.subject,
    description: screened.description,
    requester: screened.requester,
    tainted: taintedFields(mapped),
  };
  const { item: stored, created } = await ports.store.upsertItem(collector, input);
  let kind: ItemChangeKind | null = null;
  if (created) kind = "new";
  else if (
    before !== null &&
    (before.subject !== input.subject ||
      before.description !== input.description ||
      !sameLabels(before.labels, input.labels))
  )
    kind = "updated";
  const change =
    kind === null || stored.deleted
      ? null
      : { publicId: stored.publicId, change: kind, digest: changeDigest(input) };
  return { providerId: mapped.providerId, change, before, stale: false, skipped: false };
}

export type OpenResult =
  | { kind: "missing" }
  | { kind: "already_processed"; outcome: string | null }
  | { kind: "paused" }
  | { kind: "no_module" }
  | { kind: "closed"; outcome: string }
  | { kind: "ready"; collector: CollectorRecord; refs: ItemRef[] };

/**
 * Read a stored event and ask the module's doorbell for the item ids. A paused
 * collector, or a type whose module has not shipped, leaves the event
 * unprocessed. An event that can never yield items is marked processed with
 * the reason.
 */
export async function openInboundEvent(
  ports: CollectorPorts,
  inboundEventId: string,
): Promise<OpenResult> {
  const row = await ports.store.getInboundEvent(inboundEventId);
  if (!row) return { kind: "missing" };
  if (row.processedAt !== null)
    return { kind: "already_processed", outcome: row.outcome };
  const collector = await ports.store.getCollector(row.collectorId);
  if (!collector) return { kind: "missing" };
  if (collector.health === "paused") return { kind: "paused" };
  const definition = moduleFor(ports, collector.type);
  if (!definition) return { kind: "no_module" };
  if (!definition.config.safeParse(collector.scope).success) {
    await ports.store.markInboundEvent(row.id, INBOUND_OUTCOMES.scopeInvalid);
    return { kind: "closed", outcome: INBOUND_OUTCOMES.scopeInvalid };
  }
  let refs: ItemRef[];
  try {
    refs = definition.doorbell(requestFromCloudEvent(row.cloudevent));
  } catch {
    await ports.store.markInboundEvent(row.id, INBOUND_OUTCOMES.doorbellFailed);
    return { kind: "closed", outcome: INBOUND_OUTCOMES.doorbellFailed };
  }
  if (refs.length === 0) {
    await ports.store.markInboundEvent(row.id, INBOUND_OUTCOMES.noItems);
    return { kind: "closed", outcome: INBOUND_OUTCOMES.noItems };
  }
  return { kind: "ready", collector, refs };
}

/**
 * Fetch one item by id and collect it. A fetch error throws, so the durable
 * worker retries it. Returns null when the module is gone or the scope no
 * longer parses.
 */
export async function collectRef(
  ports: CollectorPorts,
  collector: CollectorRecord,
  ref: ItemRef,
): Promise<CollectResult | null> {
  const definition = moduleFor(ports, collector.type);
  if (!definition) return null;
  const config = definition.config.safeParse(collector.scope);
  if (!config.success) return null;
  const conn = await ports.connection(collector);
  const item = await definition.fetchById(ref, conn);
  return collectItem(ports, collector, definition, config.data, item);
}

/** Mark a ready event collected once every ref is stored. */
export async function closeInboundEvent(
  ports: CollectorPorts,
  inboundEventId: string,
): Promise<void> {
  await ports.store.markInboundEvent(inboundEventId, INBOUND_OUTCOMES.collected);
}

export type ProcessResult =
  | Exclude<OpenResult, { kind: "ready" }>
  | { kind: "collected"; changes: ItemChange[] };

/**
 * The whole fetch and map for one stored event. The durable worker runs the
 * same three steps one by one, so a retry repeats only the ref that failed.
 */
export async function processInboundEvent(
  ports: CollectorPorts,
  inboundEventId: string,
): Promise<ProcessResult> {
  const opened = await openInboundEvent(ports, inboundEventId);
  if (opened.kind !== "ready") return opened;
  const changes: ItemChange[] = [];
  for (const ref of opened.refs) {
    const result = await collectRef(ports, opened.collector, ref);
    if (result?.change) changes.push(result.change);
  }
  await closeInboundEvent(ports, inboundEventId);
  return { kind: "collected", changes };
}

// ── 3. Reconcile ────────────────────────────────────────────────────────────

export type ReconcilePageResult =
  | { kind: "skipped"; reason: "missing" | "paused" | "failing" | "no_module" | "scope_invalid" }
  | { kind: "failed"; error: string }
  | {
      kind: "page";
      handled: number;
      /** Changes older than MISSED_GRACE_MS that the doorbell never stored. */
      missed: number;
      changes: ItemChange[];
      hasMore: boolean;
    };

/**
 * Read one page of changes from the cursor, collect each item, and store the
 * page's cursor. A change from before the collector existed is not counted as
 * missed, so the first walk through a provider's backlog reads as healthy
 * however many pages and runs it takes. A failing collector is skipped unless
 * `force` is set, because polling stops until an admin reconnects.
 */
export async function reconcilePage(
  ports: CollectorPorts,
  collectorId: string,
  options: { force?: boolean } = {},
): Promise<ReconcilePageResult> {
  const collector = await ports.store.getCollector(collectorId);
  if (!collector) return { kind: "skipped", reason: "missing" };
  if (collector.health === "paused") return { kind: "skipped", reason: "paused" };
  if (collector.health === "failing" && !options.force)
    return { kind: "skipped", reason: "failing" };
  const definition = moduleFor(ports, collector.type);
  if (!definition) return { kind: "skipped", reason: "no_module" };
  const config = definition.config.safeParse(collector.scope);
  if (!config.success) return { kind: "skipped", reason: "scope_invalid" };
  const cutoff = ports.now().getTime() - MISSED_GRACE_MS;
  const listeningSince = Date.parse(collector.createdAt);
  try {
    const conn = await ports.connection(collector);
    const page = await definition.listChangedSince(collector.cursor, conn, config.data);
    const changes: ItemChange[] = [];
    let missed = 0;
    for (const item of page.items) {
      const result = await collectItem(ports, collector, definition, config.data, item);
      if (result.change) changes.push(result.change);
      // A module maps sourceUpdatedAt from the same provider field it puts in
      // ProviderItem.updatedAt, so the stored copy is older than this change
      // exactly when the doorbell never brought it in. A stored copy with no
      // update time gives no evidence either way, so it is not counted: a
      // module that maps none would otherwise read as lagging forever.
      // A record outside the scope is never collected, so no doorbell
      // missed it.
      const changedAt = Date.parse(item.updatedAt);
      const doorbellMissed =
        !result.skipped &&
        !result.stale &&
        changedAt > listeningSince &&
        changedAt <= cutoff &&
        (result.before === null ||
          (result.before.sourceUpdatedAt !== null &&
            Date.parse(result.before.sourceUpdatedAt) < changedAt));
      if (doorbellMissed) missed += 1;
    }
    await ports.store.setCursor(collector.id, page.cursor);
    return {
      kind: "page",
      handled: page.items.length,
      missed,
      changes,
      hasMore: page.hasMore,
    };
  } catch (err) {
    return { kind: "failed", error: messageOf(err) };
  }
}

export interface ReconcileSummary {
  ok: boolean;
  pages: number;
  handled: number;
  missed: number;
  error?: string;
}

export interface HealthChange {
  previous: CollectorHealth;
  health: CollectorHealth;
}

function resultData(row: InboundEventRecord): Record<string, unknown> {
  const data = row.cloudevent.data;
  return data !== null && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * Work out a collector's health from its latest result rows and store it when
 * it changed. A paused collector stays paused.
 */
export async function refreshHealth(
  ports: CollectorPorts,
  collectorId: string,
): Promise<HealthChange | null> {
  const collector = await ports.store.getCollector(collectorId);
  if (!collector) return null;
  const reconciles = await ports.store.listResults(collectorId, "reconcile", HEALTH_WINDOW);
  let failedStreak = 0;
  for (const row of reconciles) {
    if (row.outcome !== INBOUND_OUTCOMES.reconcileFailed) break;
    failedStreak += 1;
  }
  const lastGood = reconciles.find(
    (row) => row.outcome === INBOUND_OUTCOMES.reconciled,
  );
  const missed = lastGood ? Number(resultData(lastGood).missed ?? 0) : 0;
  const counts = await ports.store.listResults(collectorId, "count", HEALTH_WINDOW);
  const lastCount = counts.find(
    (row) =>
      row.outcome === INBOUND_OUTCOMES.countMatched ||
      row.outcome === INBOUND_OUTCOMES.countDiffered,
  );
  // The streak counts only failures newer than every finished reconcile: the
  // loop above stops at the first row that finished.
  const health = healthOf(collector.health, {
    failedStreak,
    lastReconcileMissed: missed,
    lastCountDiffered: lastCount?.outcome === INBOUND_OUTCOMES.countDiffered,
  });
  if (health !== collector.health) await ports.store.setHealth(collectorId, health);
  return { previous: collector.health, health };
}

/** Store a reconcile's result row and set the collector's health from it. */
export async function finishReconcile(
  ports: CollectorPorts,
  collectorId: string,
  summary: ReconcileSummary,
): Promise<HealthChange | null> {
  const time = ports.now().toISOString();
  const key = `${RECONCILE_KEY_PREFIX}${time}`;
  const data: Record<string, unknown> = {
    ok: summary.ok,
    pages: summary.pages,
    handled: summary.handled,
    missed: summary.missed,
  };
  if (summary.error !== undefined) data.error = summary.error;
  await ports.store.insertInboundEvent({
    collectorId,
    deliveryId: key,
    cloudevent: resultCloudEvent({
      collectorId,
      key,
      type: COLLECTOR_RECONCILE_TYPE,
      time,
      data,
    }),
    rawRef: null,
    processedAt: time,
    outcome: summary.ok
      ? INBOUND_OUTCOMES.reconciled
      : INBOUND_OUTCOMES.reconcileFailed,
  });
  return refreshHealth(ports, collectorId);
}

export type ReconcileResult =
  | { kind: "skipped"; reason: string }
  | {
      kind: "finished";
      summary: ReconcileSummary;
      changes: ItemChange[];
      health: HealthChange | null;
    };

/**
 * A whole reconcile: pages until the provider has no more, up to `maxPages`,
 * then the result row and the health. The durable worker runs each page as
 * its own step and calls finishReconcile itself.
 */
export async function reconcileCollector(
  ports: CollectorPorts,
  collectorId: string,
  options: { maxPages?: number; force?: boolean } = {},
): Promise<ReconcileResult> {
  const maxPages = options.maxPages ?? 20;
  const summary: ReconcileSummary = { ok: true, pages: 0, handled: 0, missed: 0 };
  const changes: ItemChange[] = [];
  for (let i = 0; i < maxPages; i += 1) {
    const page = await reconcilePage(ports, collectorId, { force: options.force });
    if (page.kind === "skipped") {
      if (i === 0) return { kind: "skipped", reason: page.reason };
      break;
    }
    if (page.kind === "failed") {
      summary.ok = false;
      summary.error = page.error;
      break;
    }
    summary.pages += 1;
    summary.handled += page.handled;
    summary.missed += page.missed;
    changes.push(...page.changes);
    if (!page.hasMore) break;
  }
  const health = await finishReconcile(ports, collectorId, summary);
  return { kind: "finished", summary, changes, health };
}

// ── 4. Nightly count ────────────────────────────────────────────────────────

export type CountResult =
  | { kind: "skipped"; reason: "missing" | "paused" | "failing" | "no_module" | "scope_invalid" }
  | {
      kind: "counted";
      outcome: string;
      provider: number | null;
      oxagen: number;
      health: HealthChange | null;
    };

/**
 * Count the provider's open items and Oxagen's open work items for one
 * collector, store the result, and set the health. The provider count walks
 * listChangedSince from no cursor, which the contract offers as the only way
 * to list a provider's items. A walk longer than `maxPages` stops and counts
 * as failed, which changes no health.
 */
export async function nightlyCount(
  ports: CollectorPorts,
  collectorId: string,
  options: { maxPages?: number } = {},
): Promise<CountResult> {
  const maxPages = options.maxPages ?? 50;
  const collector = await ports.store.getCollector(collectorId);
  if (!collector) return { kind: "skipped", reason: "missing" };
  if (collector.health === "paused") return { kind: "skipped", reason: "paused" };
  if (collector.health === "failing") return { kind: "skipped", reason: "failing" };
  const definition = moduleFor(ports, collector.type);
  if (!definition) return { kind: "skipped", reason: "no_module" };
  const config = definition.config.safeParse(collector.scope);
  if (!config.success) return { kind: "skipped", reason: "scope_invalid" };

  let provider: number | null = null;
  let error: string | undefined;
  try {
    const conn = await ports.connection(collector);
    const open = new Set<string>();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let finished = false;
    for (let i = 0; i < maxPages; i += 1) {
      const page = await definition.listChangedSince(cursor, conn, config.data);
      for (const item of page.items) {
        if (seen.has(item.ref.providerId)) continue;
        seen.add(item.ref.providerId);
        // A record outside the collector's scope is not open work for it.
        const mapped = definition.toWorkItem(item, config.data);
        if (mapped !== null && mapped.statusCategory !== "closed")
          open.add(item.ref.providerId);
      }
      cursor = page.cursor;
      if (!page.hasMore) {
        finished = true;
        break;
      }
    }
    if (finished) provider = open.size;
    else error = `the walk stopped at the ${maxPages}-page limit`;
  } catch (err) {
    error = messageOf(err);
  }

  const oxagen = await ports.store.countOpenItems(collectorId);
  const outcome =
    provider === null
      ? INBOUND_OUTCOMES.countFailed
      : provider === oxagen
        ? INBOUND_OUTCOMES.countMatched
        : INBOUND_OUTCOMES.countDiffered;
  const time = ports.now().toISOString();
  const key = `${COUNT_KEY_PREFIX}${time}`;
  const data: Record<string, unknown> = { provider, oxagen };
  if (error !== undefined) data.error = error;
  await ports.store.insertInboundEvent({
    collectorId,
    deliveryId: key,
    cloudevent: resultCloudEvent({
      collectorId,
      key,
      type: COLLECTOR_COUNT_TYPE,
      time,
      data,
    }),
    rawRef: null,
    processedAt: time,
    outcome,
  });
  const health = await refreshHealth(ports, collectorId);
  return { kind: "counted", outcome, provider, oxagen, health };
}
