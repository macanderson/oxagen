// A fake collector module for the framework's tests. It behaves like a real
// provider: deliveries are signed with a shared secret and name item ids, the
// items live in a provider store the test edits, and every write-back call is
// recorded. It covers every path in pipeline.ts without a network.
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { AuthCredential } from "../../connectors/types";
import { constantTimeStringEqual } from "../../connectors/safe-compare";
import type { AnyCollectorDefinition } from "../registry";
import type {
  CollectorDefinition,
  CollectorType,
  Connection,
  InboundRequest,
  ItemRef,
  Page,
  ProviderItem,
  StatusCategory,
  WorkItemInput,
  WriteBackTarget,
} from "../types";

export const FAKE_TOKEN = "fake-token";
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";
export const FAKE_DELIVERY_HEADER = "x-fake-delivery";

/** One item as the fake provider stores it. */
export interface FakeRecord {
  id: string;
  title: string;
  body: string | null;
  labels: string[];
  status: string;
  requester: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FakeConfig {
  project: string;
}

export interface WriteBackCall {
  method: "note" | "status" | "close" | "labels";
  providerId: string;
  value?: unknown;
}

export interface FakeCollector {
  definition: CollectorDefinition<FakeConfig>;
  /** The provider's items, keyed by id. Tests edit it. */
  records: Map<string, FakeRecord>;
  writeBackCalls: WriteBackCall[];
  /** When set, every call that needs the connection throws this message. */
  failWith: string | null;
  /** Items per listChangedSince page. */
  pageSize: number;
  fetchCount: number;
}

const configSchema = z.object({ project: z.string().min(1) }).strict();

function statusCategory(status: string): StatusCategory {
  if (status === "closed") return "closed";
  if (status === "blocked") return "blocked";
  return "open";
}

export function signBody(secret: string, body: Uint8Array): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * A delivery the fake provider would send, signed with `secret`. The body is
 * the payload as JSON, or `rawBody` as it stands.
 */
export function fakeDelivery(args: {
  secret: string;
  deliveryId: string;
  payload?: unknown;
  rawBody?: string;
  receivedAt?: string;
  headers?: Record<string, string>;
}): InboundRequest {
  const text = args.rawBody ?? JSON.stringify(args.payload);
  const body = new Uint8Array(Buffer.from(text, "utf8"));
  return {
    headers: {
      "Content-Type": "application/json",
      "X-Fake-Signature": signBody(args.secret, body),
      "X-Fake-Delivery": args.deliveryId,
      Authorization: "Bearer should-not-be-stored",
      ...args.headers,
    },
    body,
    receivedAt: args.receivedAt ?? "2026-09-29T12:00:00.000Z",
  };
}

export function fakeConnection(token = FAKE_TOKEN): Connection {
  return { id: "conn-fake", auth: { scheme: "bearer_token", token } };
}

export function createFakeCollector(
  options: { type?: CollectorType; withWriteBack?: boolean } = {},
): FakeCollector {
  const state: FakeCollector = {
    definition: undefined as unknown as CollectorDefinition<FakeConfig>,
    records: new Map(),
    writeBackCalls: [],
    failWith: null,
    pageSize: 2,
    fetchCount: 0,
  };

  function authorize(conn: Connection): void {
    if (state.failWith !== null) throw new Error(state.failWith);
    const auth: AuthCredential = conn.auth;
    if (auth.scheme !== "bearer_token" || auth.token !== FAKE_TOKEN)
      throw new Error("fake provider: the token was refused");
  }

  function toProviderItem(record: FakeRecord): ProviderItem {
    return {
      ref: { providerId: record.id, kind: "item" },
      updatedAt: record.updatedAt,
      record: { ...record, labels: [...record.labels] },
    };
  }

  const writeBack = {
    async note(target: WriteBackTarget, text: string) {
      state.writeBackCalls.push({ method: "note", providerId: target.ref.providerId, value: text });
    },
    async status(target: WriteBackTarget, status: string) {
      state.writeBackCalls.push({ method: "status", providerId: target.ref.providerId, value: status });
    },
    async close(target: WriteBackTarget) {
      state.writeBackCalls.push({ method: "close", providerId: target.ref.providerId });
    },
    async labels(target: WriteBackTarget, labels: { priority: string; type: string }) {
      state.writeBackCalls.push({ method: "labels", providerId: target.ref.providerId, value: labels });
    },
  };

  const definition: CollectorDefinition<FakeConfig> = {
    type: options.type ?? "zendesk",
    connectorId: "fake",
    displayName: "Fake provider",
    description: "A provider that lives in memory, for tests.",
    icon: "fake",
    supportedAuthSchemes: ["bearer_token"],
    deliveryMethod: "webhook",
    connectionConfigSchema: z.object({}),
    async previewRecordTypes() {
      return [];
    },
    normalizeRecord(_type: string, raw: unknown) {
      const record = raw as FakeRecord;
      return { externalId: record.id, properties: { ...record } };
    },
    config: configSchema,
    verify(req, secret) {
      if (secret === null) return { ok: false, reason: "no secret" };
      const signature = req.headers[FAKE_SIGNATURE_HEADER];
      const deliveryId = req.headers[FAKE_DELIVERY_HEADER];
      if (signature === undefined || deliveryId === undefined)
        return { ok: false, reason: "missing signature" };
      if (!constantTimeStringEqual(signature, signBody(secret, req.body)))
        return { ok: false, reason: "bad signature" };
      return { ok: true, deliveryId };
    },
    doorbell(req): ItemRef[] {
      const payload = JSON.parse(Buffer.from(req.body).toString("utf8")) as {
        event: string;
        ids?: string[];
      };
      if (payload.event === "ping") return [];
      if (payload.event !== "item.changed" || !Array.isArray(payload.ids))
        throw new Error("fake provider: unknown event");
      return payload.ids.map((providerId) => ({ providerId, kind: "item" }));
    },
    async fetchById(ref, conn) {
      authorize(conn);
      state.fetchCount += 1;
      const record = state.records.get(ref.providerId);
      if (!record) throw new Error(`fake provider: no item ${ref.providerId}`);
      return toProviderItem(record);
    },
    async listChangedSince(cursor, conn): Promise<Page<ProviderItem>> {
      authorize(conn);
      const changed = [...state.records.values()]
        .filter((record) => cursor === null || record.updatedAt > cursor)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
      const items = changed.slice(0, state.pageSize);
      const last = items[items.length - 1];
      return {
        items: items.map(toProviderItem),
        cursor: last?.updatedAt ?? cursor ?? "1970-01-01T00:00:00.000Z",
        hasMore: changed.length > items.length,
      };
    },
    toWorkItem(item, config): WorkItemInput {
      const record = item.record as FakeRecord;
      return {
        providerId: record.id,
        origin: "provider",
        subject: record.title,
        description: record.body,
        labels: [...record.labels],
        status: record.status,
        statusCategory: statusCategory(record.status),
        resolution: null,
        owner: null,
        requester: record.requester,
        sourceCreatedBy: record.requester,
        sourceCreatedAt: record.createdAt,
        sourceUpdatedBy: null,
        // The same field as ProviderItem.updatedAt, as pipeline.ts assumes.
        sourceUpdatedAt: record.updatedAt,
        closedAt: record.status === "closed" ? record.updatedAt : null,
        sourceUrl: `https://fake.example/${config.project}/${record.id}`,
        priorityRaw: null,
        estimateMinutes: null,
        tainted: [],
      };
    },
    ...(options.withWriteBack === false ? {} : { writeBack }),
  };
  state.definition = definition;
  return state;
}

/** The fake's definition as the registry and the ports hold it. */
export function erased(fake: FakeCollector): AnyCollectorDefinition {
  return fake.definition as unknown as AnyCollectorDefinition;
}

/** Put or replace one item in the fake provider. */
export function putRecord(
  fake: FakeCollector,
  record: Partial<FakeRecord> & { id: string; updatedAt: string },
): FakeRecord {
  const previous = fake.records.get(record.id);
  const next: FakeRecord = {
    title: `Item ${record.id}`,
    body: null,
    labels: [],
    status: "open",
    requester: null,
    createdAt: record.updatedAt,
    ...previous,
    ...record,
  };
  fake.records.set(record.id, next);
  return next;
}
