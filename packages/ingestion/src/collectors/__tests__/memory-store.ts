// An in-memory CollectorStore and ports for the framework's tests. It keeps
// the same rules as the Postgres adapter: one inbound event per collector and
// delivery id, one work item per collector and provider id, result rows read
// newest first, and an item revision that starts at 1 and moves when the
// subject, description, or label set changes.
import type { CollectorHealth } from "../health";
import {
  COUNT_KEY_PREFIX,
  type CollectorPorts,
  type CollectorRecord,
  type CollectorStore,
  type InboundEventRecord,
  type NewInboundEvent,
  RECONCILE_KEY_PREFIX,
  type StoredWorkItem,
} from "../pipeline";
import type { AnyCollectorDefinition } from "../registry";
import type { CollectorType, Connection, WorkItemInput } from "../types";
import { fakeConnection } from "./fake";

export interface MemoryItem extends StoredWorkItem {
  collectorId: string;
  providerId: string;
  number: number;
  input: WorkItemInput;
  /** The item revision. A changed subject, description, or label set moves it. */
  revision: number;
}

/** True when the material fields differ, labels compared as a set. */
function materialChanged(item: MemoryItem, input: WorkItemInput): boolean {
  const labels = (list: readonly string[]) => JSON.stringify([...new Set(list)].sort());
  return (
    item.subject !== input.subject ||
    item.description !== input.description ||
    labels(item.labels) !== labels(input.labels)
  );
}

export const TEST_ORG = "00000000-0000-4000-8000-000000000001";
export const TEST_WORKSPACE = "00000000-0000-4000-8000-000000000002";

export class MemoryCollectorStore implements CollectorStore {
  readonly collectors = new Map<string, CollectorRecord>();
  readonly events: InboundEventRecord[] = [];
  readonly items: MemoryItem[] = [];
  readonly healthWrites: CollectorHealth[] = [];
  private nextId = 1;

  constructor(private readonly clock: () => Date) {}

  addCollector(record: Partial<CollectorRecord> & { id: string }): CollectorRecord {
    const row: CollectorRecord = {
      orgId: TEST_ORG,
      workspaceId: TEST_WORKSPACE,
      name: record.id,
      type: "zendesk",
      connectionId: "conn-row-1",
      scope: { project: "support" },
      health: "healthy",
      cursor: null,
      createdAt: this.clock().toISOString(),
      ...record,
    };
    this.collectors.set(row.id, row);
    return row;
  }

  collector(id: string): CollectorRecord {
    const row = this.collectors.get(id);
    if (!row) throw new Error(`no collector ${id}`);
    return row;
  }

  async getCollector(id: string): Promise<CollectorRecord | null> {
    const row = this.collectors.get(id);
    return row ? { ...row } : null;
  }

  async hasDelivery(collectorId: string, deliveryId: string): Promise<boolean> {
    return this.events.some(
      (row) => row.collectorId === collectorId && row.deliveryId === deliveryId,
    );
  }

  async insertInboundEvent(row: NewInboundEvent): Promise<InboundEventRecord | null> {
    if (await this.hasDelivery(row.collectorId, row.deliveryId)) return null;
    const record: InboundEventRecord = {
      id: `ie-${this.nextId++}`,
      ...row,
      createdAt: this.clock().toISOString(),
    };
    this.events.push(record);
    return record;
  }

  async getInboundEvent(id: string): Promise<InboundEventRecord | null> {
    return this.events.find((row) => row.id === id) ?? null;
  }

  async markInboundEvent(id: string, outcome: string): Promise<void> {
    const row = this.events.find((event) => event.id === id);
    if (!row) throw new Error(`no inbound event ${id}`);
    row.processedAt = this.clock().toISOString();
    row.outcome = outcome;
  }

  // One provider item is one work item in the workspace, whichever collector
  // heard it (ADR-244), so the collector id plays no part in the key.
  async findItem(_collectorId: string, providerId: string): Promise<StoredWorkItem | null> {
    const item = this.items.find((row) => row.providerId === providerId);
    return item ? stored(item) : null;
  }

  async upsertItem(
    collector: CollectorRecord,
    input: WorkItemInput,
  ): Promise<{ item: StoredWorkItem; created: boolean; revision: number }> {
    const existing = this.items.find((row) => row.providerId === input.providerId);
    if (existing) {
      if (materialChanged(existing, input)) existing.revision += 1;
      existing.subject = input.subject;
      existing.description = input.description;
      existing.labels = [...input.labels];
      existing.sourceUpdatedAt = input.sourceUpdatedAt;
      existing.input = input;
      return { item: stored(existing), created: false, revision: existing.revision };
    }
    const number = this.items.length + 1;
    const item: MemoryItem = {
      id: `item-${number}`,
      publicId: `wi_${number}`,
      subject: input.subject,
      description: input.description,
      labels: [...input.labels],
      sourceUpdatedAt: input.sourceUpdatedAt,
      deleted: false,
      collectorId: collector.id,
      providerId: input.providerId,
      number,
      input,
      revision: 1,
    };
    this.items.push(item);
    return { item: stored(item), created: true, revision: item.revision };
  }

  async setCursor(collectorId: string, cursor: string): Promise<void> {
    this.collector(collectorId).cursor = cursor;
  }

  async setHealth(collectorId: string, health: CollectorHealth): Promise<void> {
    this.collector(collectorId).health = health;
    this.healthWrites.push(health);
  }

  async listResults(
    collectorId: string,
    kind: "reconcile" | "count",
    limit: number,
  ): Promise<InboundEventRecord[]> {
    const prefix = kind === "reconcile" ? RECONCILE_KEY_PREFIX : COUNT_KEY_PREFIX;
    return this.events
      .filter((row) => row.collectorId === collectorId && row.deliveryId.startsWith(prefix))
      .reverse()
      .slice(0, limit);
  }

  async countOpenItems(collectorId: string): Promise<number> {
    return this.items.filter(
      (row) =>
        row.collectorId === collectorId &&
        !row.deleted &&
        row.input.statusCategory !== "closed",
    ).length;
  }

  /** The inbound events that came through the doorbell, not the result rows. */
  deliveries(collectorId: string): InboundEventRecord[] {
    return this.events.filter(
      (row) =>
        row.collectorId === collectorId &&
        !row.deliveryId.startsWith(RECONCILE_KEY_PREFIX) &&
        !row.deliveryId.startsWith(COUNT_KEY_PREFIX),
    );
  }
}

function stored(item: MemoryItem): StoredWorkItem {
  return {
    id: item.id,
    publicId: item.publicId,
    subject: item.subject,
    description: item.description,
    labels: [...item.labels],
    sourceUpdatedAt: item.sourceUpdatedAt,
    deleted: item.deleted,
  };
}

/** The text the test screen redacts. */
export const SECRET_PATTERN = /sk-live-[A-Za-z0-9]+/g;
export const REDACTED = "[REDACTED]";

function redact(value: unknown, count: { n: number }): unknown {
  if (typeof value === "string")
    return value.replace(SECRET_PATTERN, () => {
      count.n += 1;
      return REDACTED;
    });
  if (Array.isArray(value)) return value.map((entry) => redact(entry, count));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redact(entry, count);
    return out;
  }
  return value;
}

export interface MemoryHarness {
  ports: CollectorPorts;
  store: MemoryCollectorStore;
  /** Objects putRaw kept, by key. */
  raw: Map<string, { body: Uint8Array; contentType: string }>;
  /** Move the clock forward. Every reconcile and count needs its own time. */
  advance(ms: number): Date;
  now(): Date;
  /** The token the connection port hands out. */
  token: string;
}

export function memoryHarness(
  options: { definition?: AnyCollectorDefinition; start?: string } = {},
): MemoryHarness {
  let now = new Date(options.start ?? "2026-09-29T12:00:00.000Z");
  const store = new MemoryCollectorStore(() => now);
  const raw = new Map<string, { body: Uint8Array; contentType: string }>();
  const harness: MemoryHarness = {
    store,
    raw,
    token: "fake-token",
    now: () => now,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
      return now;
    },
    ports: {
      store,
      async screen<T>(value: T) {
        const count = { n: 0 };
        const screened = redact(value, count) as T;
        return { value: screened, redactions: count.n };
      },
      async putRaw(key: string, body: Uint8Array, contentType: string) {
        raw.set(key, { body, contentType });
        return key;
      },
      async connection(collector: CollectorRecord): Promise<Connection> {
        if (collector.connectionId === null)
          throw new Error("the collector names no connection");
        return fakeConnection(harness.token);
      },
      now: () => now,
    },
  };
  if (options.definition) {
    const definition = options.definition;
    harness.ports.collectorFor = (type: CollectorType) =>
      type === definition.type ? definition : undefined;
  }
  return harness;
}
