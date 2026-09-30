// The collector pipeline, driven end to end through the fake collector: the
// doorbell, fetch and map, reconcile, the nightly count, and health.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COLLECTOR_COUNT_TYPE, COLLECTOR_RECONCILE_TYPE } from "../cloudevent";
import {
  type CollectorRecord,
  type CountResult,
  type DeliveryResult,
  type ReconcileResult,
  collectRef,
  finishReconcile,
  nightlyCount,
  processInboundEvent,
  rawBodyKey,
  receiveDelivery,
  reconcileCollector,
  refreshHealth,
  taintedFields,
  withLowercaseHeaders,
} from "../pipeline";
import { type AnyCollectorDefinition, registerCollector, unregisterCollector } from "../registry";
import type { InboundRequest, Page, ProviderItem, WorkItemInput } from "../types";
import {
  FAKE_TOKEN,
  type FakeCollector,
  type FakeConfig,
  type FakeRecord,
  createFakeCollector,
  erased,
  fakeDelivery,
  putRecord,
  signBody,
} from "./fake";
import { type MemoryHarness, REDACTED, TEST_ORG, memoryHarness } from "./memory-store";

const SECRET = "whsec_fake";
const MINUTE = 60 * 1000;
const RECONCILE_EVERY = 15 * MINUTE;
const COLLECTOR_ID = "col-1";

interface Setup {
  fake: FakeCollector;
  h: MemoryHarness;
  collector(): CollectorRecord;
  deliver(payload: unknown, deliveryId?: string): Promise<DeliveryResult>;
  deliverAndProcess(ids: string[], deliveryId?: string): ReturnType<typeof processInboundEvent>;
  ago(minutes: number): string;
}

function setup(
  options: {
    collector?: Partial<CollectorRecord>;
    definition?: (fake: FakeCollector) => AnyCollectorDefinition;
  } = {},
): Setup {
  const fake = createFakeCollector();
  const definition = options.definition ? options.definition(fake) : erased(fake);
  const h = memoryHarness({ definition });
  h.store.addCollector({ id: COLLECTOR_ID, ...options.collector });
  let next = 1;
  const collector = () => h.store.collector(COLLECTOR_ID);
  const deliver = (payload: unknown, deliveryId = `d-${next++}`) =>
    receiveDelivery(h.ports, {
      collector: collector(),
      request: fakeDelivery({ secret: SECRET, deliveryId, payload }),
      secret: SECRET,
    });
  return {
    fake,
    h,
    collector,
    deliver,
    async deliverAndProcess(ids, deliveryId) {
      const stored = await deliver({ event: "item.changed", ids }, deliveryId);
      if (stored.kind !== "stored") throw new Error(`the delivery was ${stored.kind}`);
      return processInboundEvent(h.ports, stored.inboundEventId);
    },
    ago(minutes) {
      return new Date(h.now().getTime() - minutes * MINUTE).toISOString();
    },
  };
}

function at<T>(list: readonly T[], index: number): T {
  const value = index < 0 ? list[list.length + index] : list[index];
  if (value === undefined) throw new Error(`nothing at index ${index}`);
  return value;
}

function finished(result: ReconcileResult) {
  if (result.kind !== "finished") throw new Error(`expected a finished reconcile, got ${result.kind}`);
  return result;
}

function counted(result: CountResult) {
  if (result.kind !== "counted") throw new Error(`expected a count, got ${result.kind}`);
  return result;
}

function stored(result: DeliveryResult) {
  if (result.kind !== "stored") throw new Error(`expected a stored delivery, got ${result.kind}`);
  return result;
}

/** A signed request with exactly these headers. */
function signedRequest(text: string, headers: Record<string, string>): InboundRequest {
  const body = new Uint8Array(Buffer.from(text, "utf8"));
  return {
    headers: { "X-Fake-Signature": signBody(SECRET, body), ...headers },
    body,
    receivedAt: "2026-09-29T12:00:00.000Z",
  };
}

function providerItem(record: FakeRecord): ProviderItem {
  return { ref: { providerId: record.id, kind: "item" }, updatedAt: record.updatedAt, record };
}

function record(id: string, updatedAt: string, status = "open"): FakeRecord {
  return {
    id,
    title: `Item ${id}`,
    body: null,
    labels: [],
    status,
    requester: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("the collector pipeline, through the fake collector", () => {
  it("stores a delivery once, fetches and maps its item, and reconciles what the doorbell missed", async () => {
    const s = setup();
    const { fake, h } = s;
    const putRaw = vi.spyOn(h.ports, "putRaw");
    putRecord(fake, {
      id: "101",
      title: "Checkout fails",
      body: "The log shows sk-live-abc123 in the request",
      requester: "ana@example.com",
      updatedAt: s.ago(1),
    });

    // The doorbell: verify, store the CloudEvent keyed by the delivery id.
    const payload = { event: "item.changed", ids: ["101"], note: "sk-live-payload9" };
    const request = fakeDelivery({ secret: SECRET, deliveryId: "d-1", payload });
    const first = await receiveDelivery(h.ports, {
      collector: s.collector(),
      request,
      secret: SECRET,
    });
    expect(first).toEqual({ kind: "stored", inboundEventId: "ie-1", deliveryId: "d-1", paused: false });
    const event = at(h.store.events, 0);
    expect(event.deliveryId).toBe("d-1");
    expect(event.cloudevent.id).toBe("d-1");
    expect(event.cloudevent.data).toEqual({ event: "item.changed", ids: ["101"], note: REDACTED });
    const headers = JSON.parse(event.cloudevent.oxagenheaders ?? "{}") as Record<string, string>;
    expect(headers["x-fake-delivery"]).toBe("d-1");
    expect(headers).not.toHaveProperty("authorization");
    const key = rawBodyKey(TEST_ORG, request.body);
    expect(event.rawRef).toBe(key);
    expect(h.raw.get(key)?.body).toEqual(request.body);
    expect(h.raw.get(key)?.contentType).toBe("application/json");

    // The same delivery id again writes nothing.
    const again = await receiveDelivery(h.ports, {
      collector: s.collector(),
      request: fakeDelivery({ secret: SECRET, deliveryId: "d-1", payload }),
      secret: SECRET,
    });
    expect(again).toEqual({ kind: "duplicate", deliveryId: "d-1" });
    expect(h.store.deliveries(COLLECTOR_ID)).toHaveLength(1);
    expect(putRaw).toHaveBeenCalledTimes(1);

    // Fetch by id, map, screen, and upsert.
    const processed = await processInboundEvent(h.ports, "ie-1");
    expect(processed).toEqual({
      kind: "collected",
      changes: [{ publicId: "wi_1", change: "new", digest: expect.stringMatching(/^[0-9a-f]{16}$/) as string }],
    });
    const item = at(h.store.items, 0);
    expect(item.description).toBe(`The log shows ${REDACTED} in the request`);
    expect(item.input.tainted).toEqual(["subject", "description", "requester"]);
    expect(item.input.sourceUrl).toBe("https://fake.example/support/101");
    expect(at(h.store.events, 0).outcome).toBe("collected");
    expect(at(h.store.events, 0).processedAt).not.toBeNull();
    expect(fake.fetchCount).toBe(1);

    // A processed event is not fetched twice.
    expect(await processInboundEvent(h.ports, "ie-1")).toEqual({
      kind: "already_processed",
      outcome: "collected",
    });
    expect(fake.fetchCount).toBe(1);

    // A changed subject reports updated.
    h.advance(MINUTE);
    putRecord(fake, { id: "101", title: "Checkout fails on retry", updatedAt: h.now().toISOString() });
    const updated = await s.deliverAndProcess(["101"], "d-2");
    expect(updated).toMatchObject({ kind: "collected", changes: [{ publicId: "wi_1", change: "updated" }] });
    expect(h.store.items).toHaveLength(1);

    // The first reconcile finds nothing the doorbell missed: 101 came through it.
    h.advance(RECONCILE_EVERY);
    const firstReconcile = finished(await reconcileCollector(h.ports, COLLECTOR_ID));
    expect(firstReconcile.summary).toEqual({ ok: true, pages: 1, handled: 1, missed: 0 });
    expect(firstReconcile.changes).toEqual([]);
    expect(firstReconcile.health).toEqual({ previous: "healthy", health: "healthy" });
    expect(s.collector().cursor).toBe("2026-09-29T12:01:00.000Z");
    const resultRow = at(h.store.events, -1);
    expect(resultRow.cloudevent.type).toBe(COLLECTOR_RECONCILE_TYPE);
    expect(resultRow.deliveryId).toBe("reconcile:2026-09-29T12:16:00.000Z");
    expect(resultRow.outcome).toBe("reconciled");
    expect(resultRow.cloudevent.data).toEqual({ ok: true, pages: 1, handled: 1, missed: 0 });

    // 102 changed ten minutes ago and never rang the doorbell: missed.
    // 103 changed a minute ago and may still be on its way: not missed.
    // 101 came through the doorbell: not missed.
    h.advance(RECONCILE_EVERY);
    putRecord(fake, { id: "102", updatedAt: s.ago(10) });
    putRecord(fake, { id: "103", updatedAt: s.ago(1) });
    putRecord(fake, { id: "101", title: "Checkout fails every time", updatedAt: s.ago(8) });
    expect(await s.deliverAndProcess(["101"], "d-3")).toMatchObject({
      kind: "collected",
      changes: [{ publicId: "wi_1", change: "updated" }],
    });
    const lagging = finished(await reconcileCollector(h.ports, COLLECTOR_ID));
    expect(lagging.summary).toEqual({ ok: true, pages: 2, handled: 3, missed: 1 });
    expect(lagging.changes.map((c) => [c.publicId, c.change])).toEqual([
      ["wi_2", "new"],
      ["wi_3", "new"],
    ]);
    expect(lagging.health).toEqual({ previous: "healthy", health: "lagging" });
    expect(s.collector().health).toBe("lagging");

    // A reconcile that misses nothing makes it healthy again.
    h.advance(RECONCILE_EVERY);
    const caughtUp = finished(await reconcileCollector(h.ports, COLLECTOR_ID));
    expect(caughtUp.summary).toEqual({ ok: true, pages: 1, handled: 0, missed: 0 });
    expect(caughtUp.health).toEqual({ previous: "lagging", health: "healthy" });
    expect(h.store.deliveries(COLLECTOR_ID)).toHaveLength(3);
  });
});

describe("health", () => {
  it("moves to failing after three failed reconciles in a row, and back after a forced one", async () => {
    const s = setup();
    const { fake, h } = s;
    putRecord(fake, { id: "101", updatedAt: s.ago(30) });
    h.token = "revoked";
    const healths: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      h.advance(RECONCILE_EVERY);
      const result = finished(await reconcileCollector(h.ports, COLLECTOR_ID));
      expect(result.summary).toEqual({
        ok: false,
        pages: 0,
        handled: 0,
        missed: 0,
        error: "fake provider: the token was refused",
      });
      healths.push(result.health?.health ?? "none");
    }
    expect(healths).toEqual(["healthy", "healthy", "failing"]);
    expect(at(h.store.events, -1).outcome).toBe("reconcile_failed");

    // Polling stops.
    h.advance(RECONCILE_EVERY);
    expect(await reconcileCollector(h.ports, COLLECTOR_ID)).toEqual({ kind: "skipped", reason: "failing" });
    expect(await nightlyCount(h.ports, COLLECTOR_ID)).toEqual({ kind: "skipped", reason: "failing" });

    // A forced reconcile that still fails leaves it failing.
    h.advance(MINUTE);
    const stillFailing = finished(await reconcileCollector(h.ports, COLLECTOR_ID, { force: true }));
    expect(stillFailing.health).toEqual({ previous: "failing", health: "failing" });

    // Reconnected: a forced reconcile that works makes it healthy.
    h.token = FAKE_TOKEN;
    h.advance(MINUTE);
    const recovered = finished(await reconcileCollector(h.ports, COLLECTOR_ID, { force: true }));
    expect(recovered.summary.ok).toBe(true);
    expect(recovered.health).toEqual({ previous: "failing", health: "healthy" });
  });

  it("counts only failures in a row", async () => {
    const s = setup();
    const { fake, h } = s;
    putRecord(fake, { id: "101", updatedAt: s.ago(30) });
    const healths: string[] = [];
    for (const token of ["revoked", "revoked", FAKE_TOKEN, "revoked"]) {
      h.token = token;
      h.advance(RECONCILE_EVERY);
      healths.push(finished(await reconcileCollector(h.ports, COLLECTOR_ID)).health?.health ?? "none");
    }
    expect(healths).toEqual(["healthy", "healthy", "healthy", "healthy"]);
  });

  it("moves to lagging when the nightly count differs, and back when it matches", async () => {
    const s = setup();
    const { fake, h } = s;
    putRecord(fake, { id: "201", updatedAt: s.ago(30) });
    putRecord(fake, { id: "202", updatedAt: s.ago(29) });
    putRecord(fake, { id: "203", status: "closed", updatedAt: s.ago(28) });
    finished(await reconcileCollector(h.ports, COLLECTOR_ID));

    h.advance(MINUTE);
    const matched = counted(await nightlyCount(h.ports, COLLECTOR_ID));
    expect(matched).toMatchObject({ outcome: "count_matched", provider: 2, oxagen: 2 });
    expect(matched.health).toEqual({ previous: "healthy", health: "healthy" });

    putRecord(fake, { id: "204", updatedAt: s.ago(1) });
    h.advance(MINUTE);
    const differed = counted(await nightlyCount(h.ports, COLLECTOR_ID));
    expect(differed).toMatchObject({ outcome: "count_differed", provider: 3, oxagen: 2 });
    expect(differed.health).toEqual({ previous: "healthy", health: "lagging" });
    const countRow = at(h.store.events, -1);
    expect(countRow.cloudevent.type).toBe(COLLECTOR_COUNT_TYPE);
    expect(countRow.deliveryId).toBe(`count:${h.now().toISOString()}`);
    expect(countRow.cloudevent.data).toEqual({ provider: 3, oxagen: 2 });

    await s.deliverAndProcess(["204"]);
    h.advance(MINUTE);
    const back = counted(await nightlyCount(h.ports, COLLECTOR_ID));
    expect(back).toMatchObject({ outcome: "count_matched", provider: 3, oxagen: 3 });
    expect(back.health).toEqual({ previous: "lagging", health: "healthy" });
  });

  it("stops everything while paused, and only a person moves it out", async () => {
    const s = setup({ collector: { health: "paused" } });
    const { fake, h } = s;
    putRecord(fake, { id: "301", updatedAt: s.ago(30) });

    const delivery = stored(await s.deliver({ event: "item.changed", ids: ["301"] }));
    expect(delivery.paused).toBe(true);
    expect(await processInboundEvent(h.ports, delivery.inboundEventId)).toEqual({ kind: "paused" });
    expect(at(h.store.events, 0).processedAt).toBeNull();
    expect(fake.fetchCount).toBe(0);

    expect(await reconcileCollector(h.ports, COLLECTOR_ID)).toEqual({ kind: "skipped", reason: "paused" });
    expect(await nightlyCount(h.ports, COLLECTOR_ID)).toEqual({ kind: "skipped", reason: "paused" });

    for (let i = 0; i < 3; i += 1) {
      h.advance(RECONCILE_EVERY);
      expect(
        await finishReconcile(h.ports, COLLECTOR_ID, { ok: false, pages: 0, handled: 0, missed: 0, error: "down" }),
      ).toEqual({ previous: "paused", health: "paused" });
    }
    expect(s.collector().health).toBe("paused");
    expect(h.store.healthWrites).toEqual([]);
  });

  it("returns null for a collector that is gone", async () => {
    const { h } = setup();
    expect(await refreshHealth(h.ports, "col-gone")).toBeNull();
    expect(await finishReconcile(h.ports, "col-gone", { ok: true, pages: 0, handled: 0, missed: 0 })).toBeNull();
  });

  it("reads a result row whose data is not an object as nothing missed", async () => {
    const s = setup({ collector: { health: "lagging" } });
    const time = s.h.now().toISOString();
    await s.h.store.insertInboundEvent({
      collectorId: COLLECTOR_ID,
      deliveryId: `reconcile:${time}`,
      cloudevent: {
        specversion: "1.0",
        id: `reconcile:${time}`,
        source: `/work/collectors/${COLLECTOR_ID}`,
        type: COLLECTOR_RECONCILE_TYPE,
        time,
        data: "not an object",
      },
      rawRef: null,
      processedAt: time,
      outcome: "reconciled",
    });
    expect(await refreshHealth(s.h.ports, COLLECTOR_ID)).toEqual({ previous: "lagging", health: "healthy" });
  });
});

describe("receiveDelivery", () => {
  it("returns no_module for a type with no module", async () => {
    const s = setup({ collector: { type: "jira" } });
    expect(await s.deliver({ event: "ping" })).toEqual({ kind: "no_module" });
    expect(s.h.store.events).toEqual([]);
  });

  it("rejects a bad signature, a missing signature, and a missing secret", async () => {
    const s = setup();
    const collector = s.collector();
    const badSignature = await receiveDelivery(s.h.ports, {
      collector,
      request: fakeDelivery({ secret: "another-secret", deliveryId: "d-1", payload: { event: "ping" } }),
      secret: SECRET,
    });
    expect(badSignature).toEqual({ kind: "rejected", reason: "bad signature" });
    const unsigned = await receiveDelivery(s.h.ports, {
      collector,
      request: signedRequest('{"event":"ping"}', { "Content-Type": "application/json" }),
      secret: SECRET,
    });
    expect(unsigned).toEqual({ kind: "rejected", reason: "missing signature" });
    const noSecret = await receiveDelivery(s.h.ports, {
      collector,
      request: fakeDelivery({ secret: SECRET, deliveryId: "d-1", payload: { event: "ping" } }),
      secret: null,
    });
    expect(noSecret).toEqual({ kind: "rejected", reason: "no secret" });
    expect(s.h.store.events).toEqual([]);
    expect(s.h.raw.size).toBe(0);
  });

  it("returns duplicate when a second delivery wins the race to the insert", async () => {
    const s = setup();
    stored(await s.deliver({ event: "ping" }, "d-race"));
    vi.spyOn(s.h.store, "hasDelivery").mockResolvedValueOnce(false);
    expect(await s.deliver({ event: "ping" }, "d-race")).toEqual({ kind: "duplicate", deliveryId: "d-race" });
    expect(s.h.store.deliveries(COLLECTOR_ID)).toHaveLength(1);
  });

  it("screens the text inside a body that is not JSON", async () => {
    const s = setup();
    const withSecret = stored(
      await receiveDelivery(s.h.ports, {
        collector: s.collector(),
        request: fakeDelivery({
          secret: SECRET,
          deliveryId: "d-text-1",
          rawBody: "token sk-live-zzz9 here",
          headers: { "Content-Type": "text/plain" },
        }),
        secret: SECRET,
      }),
    );
    const screened = at(s.h.store.events, 0).cloudevent;
    expect(withSecret.deliveryId).toBe("d-text-1");
    expect(screened.data).toBeUndefined();
    expect(screened.datacontenttype).toBe("text/plain");
    expect(Buffer.from(screened.data_base64 ?? "", "base64").toString("utf8")).toBe(`token ${REDACTED} here`);

    stored(
      await receiveDelivery(s.h.ports, {
        collector: s.collector(),
        request: fakeDelivery({
          secret: SECRET,
          deliveryId: "d-text-2",
          rawBody: "nothing to hide",
          headers: { "Content-Type": "text/plain" },
        }),
        secret: SECRET,
      }),
    );
    const plain = at(s.h.store.events, 1).cloudevent;
    expect(plain.data_base64).toBe(Buffer.from("nothing to hide", "utf8").toString("base64"));
  });

  it("stores a body with no content type as octet-stream", async () => {
    const s = setup();
    const request = signedRequest('{"event":"ping"}', { "X-Fake-Delivery": "d-bare" });
    stored(await receiveDelivery(s.h.ports, { collector: s.collector(), request, secret: SECRET }));
    expect(s.h.raw.get(rawBodyKey(TEST_ORG, request.body))?.contentType).toBe("application/octet-stream");
    expect(at(s.h.store.events, 0).cloudevent.data).toEqual({ event: "ping" });
  });
});

describe("processInboundEvent", () => {
  it("returns missing for an event or a collector that is gone", async () => {
    const s = setup();
    expect(await processInboundEvent(s.h.ports, "ie-404")).toEqual({ kind: "missing" });
    const delivery = stored(await s.deliver({ event: "ping" }));
    s.h.store.collectors.delete(COLLECTOR_ID);
    expect(await processInboundEvent(s.h.ports, delivery.inboundEventId)).toEqual({ kind: "missing" });
  });

  it("leaves the event waiting when the type's module is gone", async () => {
    const s = setup();
    const delivery = stored(await s.deliver({ event: "ping" }));
    s.collector().type = "jira";
    expect(await processInboundEvent(s.h.ports, delivery.inboundEventId)).toEqual({ kind: "no_module" });
    expect(at(s.h.store.events, 0).processedAt).toBeNull();
  });

  it("closes an event whose collector scope no longer parses", async () => {
    const s = setup();
    const delivery = stored(await s.deliver({ event: "item.changed", ids: ["101"] }));
    s.collector().scope = {};
    expect(await processInboundEvent(s.h.ports, delivery.inboundEventId)).toEqual({
      kind: "closed",
      outcome: "scope_invalid",
    });
    expect(at(s.h.store.events, 0).outcome).toBe("scope_invalid");
  });

  it("closes an event the doorbell cannot read, and one that names no items", async () => {
    const s = setup();
    const unknown = stored(await s.deliver({ event: "item.renamed" }));
    expect(await processInboundEvent(s.h.ports, unknown.inboundEventId)).toEqual({
      kind: "closed",
      outcome: "doorbell_failed",
    });
    const ping = stored(await s.deliver({ event: "ping" }));
    expect(await processInboundEvent(s.h.ports, ping.inboundEventId)).toEqual({
      kind: "closed",
      outcome: "no_items",
    });
  });

  it("throws on a fetch error and leaves the event for the retry", async () => {
    const s = setup();
    const delivery = stored(await s.deliver({ event: "item.changed", ids: ["999"] }));
    await expect(processInboundEvent(s.h.ports, delivery.inboundEventId)).rejects.toThrow(
      "fake provider: no item 999",
    );
    expect(at(s.h.store.events, 0).processedAt).toBeNull();
  });

  it("throws when the collector names no connection", async () => {
    const s = setup({ collector: { connectionId: null } });
    putRecord(s.fake, { id: "101", updatedAt: s.ago(1) });
    const delivery = stored(await s.deliver({ event: "item.changed", ids: ["101"] }));
    await expect(processInboundEvent(s.h.ports, delivery.inboundEventId)).rejects.toThrow(
      "the collector names no connection",
    );
  });

  it("keeps a deleted item current and reports nothing for it", async () => {
    const s = setup();
    putRecord(s.fake, { id: "101", title: "First", updatedAt: s.ago(2) });
    await s.deliverAndProcess(["101"]);
    at(s.h.store.items, 0).deleted = true;
    putRecord(s.fake, { id: "101", title: "Second", updatedAt: s.ago(1) });
    expect(await s.deliverAndProcess(["101"])).toEqual({ kind: "collected", changes: [] });
    expect(at(s.h.store.items, 0).subject).toBe("Second");
  });

  it("reports no change for an unchanged item or reordered labels, and updated for a new label", async () => {
    const s = setup();
    putRecord(s.fake, { id: "101", labels: ["a", "b"], updatedAt: s.ago(3) });
    await s.deliverAndProcess(["101"]);
    expect(await s.deliverAndProcess(["101"])).toEqual({ kind: "collected", changes: [] });
    putRecord(s.fake, { id: "101", labels: ["b", "a"], updatedAt: s.ago(2) });
    expect(await s.deliverAndProcess(["101"])).toEqual({ kind: "collected", changes: [] });
    putRecord(s.fake, { id: "101", labels: ["b", "a", "c"], updatedAt: s.ago(1) });
    expect(await s.deliverAndProcess(["101"])).toMatchObject({
      kind: "collected",
      changes: [{ publicId: "wi_1", change: "updated" }],
    });
  });

  it("leaves a newer stored item alone when a late read brings an older copy", async () => {
    const s = setup();
    putRecord(s.fake, { id: "101", title: "Current", updatedAt: s.ago(1) });
    await s.deliverAndProcess(["101"]);
    putRecord(s.fake, { id: "101", title: "Older", updatedAt: s.ago(60) });
    expect(await s.deliverAndProcess(["101"])).toEqual({ kind: "collected", changes: [] });
    expect(at(s.h.store.items, 0).subject).toBe("Current");
  });

  it("finds the module in the registry when no port names one", async () => {
    const fake = createFakeCollector({ type: "servicenow" });
    registerCollector(fake.definition);
    const h = memoryHarness();
    h.store.addCollector({ id: COLLECTOR_ID, type: "servicenow" });
    putRecord(fake, { id: "501", updatedAt: "2026-09-29T11:00:00.000Z" });
    const delivery = stored(
      await receiveDelivery(h.ports, {
        collector: h.store.collector(COLLECTOR_ID),
        request: fakeDelivery({ secret: SECRET, deliveryId: "d-1", payload: { event: "item.changed", ids: ["501"] } }),
        secret: SECRET,
      }),
    );
    expect(await processInboundEvent(h.ports, delivery.inboundEventId)).toMatchObject({
      kind: "collected",
      changes: [{ publicId: "wi_1", change: "new" }],
    });
  });
});

afterEach(() => {
  unregisterCollector("servicenow");
});

describe("collectRef", () => {
  it("returns null when the module is gone or the scope does not parse", async () => {
    const s = setup();
    const ref = { providerId: "101", kind: "item" };
    expect(await collectRef(s.h.ports, { ...s.collector(), type: "jira" }, ref)).toBeNull();
    expect(await collectRef(s.h.ports, { ...s.collector(), scope: {} }, ref)).toBeNull();
  });
});

describe("taintedFields", () => {
  const base: WorkItemInput = {
    providerId: "1",
    origin: "provider",
    subject: "Subject",
    description: null,
    labels: [],
    status: "open",
    statusCategory: "open",
    resolution: null,
    owner: null,
    requester: null,
    sourceCreatedBy: null,
    sourceCreatedAt: null,
    sourceUpdatedBy: null,
    sourceUpdatedAt: null,
    closedAt: null,
    sourceUrl: null,
    priorityRaw: null,
    estimateMinutes: null,
    tainted: [],
  };

  it("always marks the subject", () => {
    expect(taintedFields(base)).toEqual(["subject"]);
  });

  it("marks the description and requester when present", () => {
    expect(taintedFields({ ...base, description: "d", requester: "r" })).toEqual([
      "subject",
      "description",
      "requester",
    ]);
  });

  it("keeps what the module marked", () => {
    expect(taintedFields({ ...base, tainted: ["requester"] })).toEqual(["subject", "requester"]);
  });
});

describe("reconcileCollector", () => {
  it("reads every page, resumes from the cursor after the page limit, and counts no backlog as missed", async () => {
    const s = setup();
    for (let i = 1; i <= 5; i += 1) putRecord(s.fake, { id: `40${i}`, updatedAt: s.ago(60 - i) });
    const all = finished(await reconcileCollector(s.h.ports, COLLECTOR_ID));
    expect(all.summary).toEqual({ ok: true, pages: 3, handled: 5, missed: 0 });
    expect(all.changes).toHaveLength(5);

    const t = setup();
    for (let i = 1; i <= 5; i += 1) putRecord(t.fake, { id: `40${i}`, updatedAt: t.ago(60 - i) });
    const limited = finished(await reconcileCollector(t.h.ports, COLLECTOR_ID, { maxPages: 2 }));
    expect(limited.summary).toEqual({ ok: true, pages: 2, handled: 4, missed: 0 });
    expect(t.collector().cursor).toBe(t.ago(56));
    // The rest of the backlog changed before the collector existed, so the
    // second run counts it as read, not as missed by the doorbell.
    t.h.advance(RECONCILE_EVERY);
    const rest = finished(await reconcileCollector(t.h.ports, COLLECTOR_ID));
    expect(rest.summary).toEqual({ ok: true, pages: 1, handled: 1, missed: 0 });
    expect(rest.health).toEqual({ previous: "healthy", health: "healthy" });
  });

  it("skips a collector that is gone, has no module, or has a scope that does not parse", async () => {
    const s = setup();
    expect(await reconcileCollector(s.h.ports, "col-gone")).toEqual({ kind: "skipped", reason: "missing" });
    s.collector().type = "jira";
    expect(await reconcileCollector(s.h.ports, COLLECTOR_ID)).toEqual({ kind: "skipped", reason: "no_module" });
    s.collector().type = "zendesk";
    s.collector().scope = { project: "" };
    expect(await reconcileCollector(s.h.ports, COLLECTOR_ID)).toEqual({ kind: "skipped", reason: "scope_invalid" });
  });

  it("fails when the collector names no connection", async () => {
    const s = setup({ collector: { connectionId: null } });
    const result = finished(await reconcileCollector(s.h.ports, COLLECTOR_ID));
    expect(result.summary).toMatchObject({ ok: false, error: "the collector names no connection" });
  });

  it("stops between pages when a person pauses the collector", async () => {
    const s = setup();
    for (let i = 1; i <= 5; i += 1) putRecord(s.fake, { id: `40${i}`, updatedAt: s.ago(60 - i) });
    const setCursor = s.h.store.setCursor.bind(s.h.store);
    vi.spyOn(s.h.store, "setCursor").mockImplementation(async (id, cursor) => {
      await setCursor(id, cursor);
      s.h.store.collector(id).health = "paused";
    });
    const result = finished(await reconcileCollector(s.h.ports, COLLECTOR_ID));
    expect(result.summary).toEqual({ ok: true, pages: 1, handled: 2, missed: 0 });
    expect(result.health).toEqual({ previous: "paused", health: "paused" });
  });

  it("counts an update the doorbell never brought as missed", async () => {
    const s = setup();
    putRecord(s.fake, { id: "101", updatedAt: s.ago(30) });
    finished(await reconcileCollector(s.h.ports, COLLECTOR_ID));
    // The change comes after the collector existed and past the grace time.
    s.h.advance(RECONCILE_EVERY);
    putRecord(s.fake, { id: "101", title: "Changed quietly", updatedAt: s.ago(10) });
    const result = finished(await reconcileCollector(s.h.ports, COLLECTOR_ID));
    expect(result.summary).toEqual({ ok: true, pages: 1, handled: 1, missed: 1 });
    expect(result.changes).toMatchObject([{ publicId: "wi_1", change: "updated" }]);
    expect(result.health?.health).toBe("lagging");
  });

  it("does not count a stale copy as missed", async () => {
    const s = setup();
    putRecord(s.fake, { id: "101", title: "First", updatedAt: s.ago(30) });
    finished(await reconcileCollector(s.h.ports, COLLECTOR_ID));
    s.h.advance(RECONCILE_EVERY);
    putRecord(s.fake, { id: "101", title: "Current", updatedAt: s.ago(7) });
    await s.deliverAndProcess(["101"]);
    // A lagging replica lists an older copy than the doorbell brought.
    putRecord(s.fake, { id: "101", title: "Stale", updatedAt: s.ago(10) });
    const result = finished(await reconcileCollector(s.h.ports, COLLECTOR_ID));
    expect(result.summary).toEqual({ ok: true, pages: 1, handled: 1, missed: 0 });
    expect(at(s.h.store.items, 0).subject).toBe("Current");
  });

  it("does not count an item as missed when its stored copy has no update time", async () => {
    const s = setup({
      definition: (fake) => ({
        ...erased(fake),
        toWorkItem: (item, config) => {
          const mapped = fake.definition.toWorkItem(item, config as FakeConfig);
          return mapped === null ? null : { ...mapped, sourceUpdatedAt: null };
        },
      }),
    });
    putRecord(s.fake, { id: "101", updatedAt: s.ago(30) });
    finished(await reconcileCollector(s.h.ports, COLLECTOR_ID));
    s.h.advance(RECONCILE_EVERY);
    putRecord(s.fake, { id: "101", updatedAt: s.ago(10) });
    const result = finished(await reconcileCollector(s.h.ports, COLLECTOR_ID));
    expect(result.summary).toEqual({ ok: true, pages: 1, handled: 1, missed: 0 });
    expect(result.health?.health).toBe("healthy");
  });
});

describe("nightlyCount", () => {
  it("fails without changing health when the walk passes the page limit", async () => {
    const s = setup();
    for (let i = 1; i <= 3; i += 1) putRecord(s.fake, { id: `60${i}`, updatedAt: s.ago(60 - i) });
    const result = counted(await nightlyCount(s.h.ports, COLLECTOR_ID, { maxPages: 1 }));
    expect(result).toMatchObject({ outcome: "count_failed", provider: null, oxagen: 0 });
    expect(result.health).toEqual({ previous: "healthy", health: "healthy" });
    expect(at(s.h.store.events, -1).cloudevent.data).toEqual({
      provider: null,
      oxagen: 0,
      error: "the walk stopped at the 1-page limit",
    });
  });

  it("fails without changing health when the provider errors", async () => {
    const s = setup();
    s.fake.failWith = "fake provider: down";
    const result = counted(await nightlyCount(s.h.ports, COLLECTOR_ID));
    expect(result).toMatchObject({ outcome: "count_failed", provider: null });
    expect(at(s.h.store.events, -1).cloudevent.data).toMatchObject({ error: "fake provider: down" });
    expect(s.collector().health).toBe("healthy");
  });

  it("counts an item listed on two pages once", async () => {
    const s = setup({
      definition: (fake) => ({
        ...erased(fake),
        async listChangedSince(cursor): Promise<Page<ProviderItem>> {
          const t = "2026-09-29T11:00:00.000Z";
          return cursor === null
            ? { items: [providerItem(record("a", t)), providerItem(record("b", t))], cursor: "p1", hasMore: true }
            : { items: [providerItem(record("b", t)), providerItem(record("c", t))], cursor: "p2", hasMore: false };
        },
      }),
    });
    const result = counted(await nightlyCount(s.h.ports, COLLECTOR_ID));
    expect(result).toMatchObject({ outcome: "count_differed", provider: 3, oxagen: 0 });
  });

  it("skips a collector that is gone, has no module, or has a scope that does not parse", async () => {
    const s = setup();
    expect(await nightlyCount(s.h.ports, "col-gone")).toEqual({ kind: "skipped", reason: "missing" });
    s.collector().type = "jira";
    expect(await nightlyCount(s.h.ports, COLLECTOR_ID)).toEqual({ kind: "skipped", reason: "no_module" });
    s.collector().type = "zendesk";
    s.collector().scope = {};
    expect(await nightlyCount(s.h.ports, COLLECTOR_ID)).toEqual({ kind: "skipped", reason: "scope_invalid" });
  });
});

describe("helpers", () => {
  it("keys a raw body by its SHA-256 under the org", () => {
    const body = new Uint8Array(Buffer.from("hello", "utf8"));
    const hex = createHash("sha256").update(body).digest("hex");
    expect(rawBodyKey("org-1", body)).toBe(`work/inbound/org-1/${hex}`);
  });

  it("lowercases header names and keeps the rest", () => {
    const request: InboundRequest = {
      headers: { "X-Fake-Delivery": "d-1", "content-type": "text/plain" },
      body: new Uint8Array([1, 2]),
      receivedAt: "2026-09-29T12:00:00.000Z",
    };
    expect(withLowercaseHeaders(request)).toEqual({
      headers: { "x-fake-delivery": "d-1", "content-type": "text/plain" },
      body: request.body,
      receivedAt: request.receivedAt,
    });
  });
});
