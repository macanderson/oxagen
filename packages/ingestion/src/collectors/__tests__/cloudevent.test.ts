// The CloudEvents envelope a stored delivery keeps, and the request doorbell
// reads back from it.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COLLECTOR_COUNT_TYPE,
  COLLECTOR_DELIVERY_TYPE,
  COLLECTOR_RECONCILE_TYPE,
  type CollectorCloudEvent,
  bodyDigest,
  collectorSource,
  deliveryCloudEvent,
  requestFromCloudEvent,
  resultCloudEvent,
} from "../cloudevent";
import type { InboundRequest } from "../types";
import { fakeDelivery, signBody } from "./fake";

const SECRET = "whsec_fake";
const RECEIVED_AT = "2026-09-29T12:00:00.000Z";
/** The SHA-256 of zero bytes, a published constant. */
const EMPTY_SHA256 =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "utf8"));
}

function textOf(body: Uint8Array): string {
  return Buffer.from(body).toString("utf8");
}

function base64Of(value: string | number[]): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value)).toString(
    "base64",
  );
}

function request(headers: Record<string, string>, body: string | Uint8Array): InboundRequest {
  return {
    headers,
    body: typeof body === "string" ? bytes(body) : body,
    receivedAt: RECEIVED_AT,
  };
}

function wrap(req: InboundRequest): CollectorCloudEvent {
  return deliveryCloudEvent({ collectorId: "col-1", deliveryId: "d-1", request: req });
}

function storedHeaders(event: CollectorCloudEvent): unknown {
  if (event.oxagenheaders === undefined) throw new Error("the event stores no headers");
  return JSON.parse(event.oxagenheaders) as unknown;
}

function storedEvent(fields: Partial<CollectorCloudEvent>): CollectorCloudEvent {
  return {
    specversion: "1.0",
    id: "d-1",
    source: "/work/collectors/col-1",
    type: COLLECTOR_DELIVERY_TYPE,
    time: RECEIVED_AT,
    ...fields,
  };
}

describe("bodyDigest and collectorSource", () => {
  it("digests the raw body as sha256 and lowercase hex", () => {
    expect(bodyDigest(new Uint8Array())).toBe(EMPTY_SHA256);
    const digest = bodyDigest(bytes("abc"));
    expect(digest).toBe(`sha256:${createHash("sha256").update("abc").digest("hex")}`);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("names a collector's source by its id", () => {
    expect(collectorSource("col-1")).toBe("/work/collectors/col-1");
  });
});

describe("deliveryCloudEvent", () => {
  it("wraps a JSON delivery as data, with the delivery id, source, type, time, and digest", () => {
    const payload = { event: "item.changed", ids: ["101", "102"] };
    const req = fakeDelivery({ secret: SECRET, deliveryId: "d-1", payload });
    const event = wrap(req);
    expect(event).toEqual({
      specversion: "1.0",
      id: "d-1",
      source: "/work/collectors/col-1",
      type: "sh.oxagen.work.collector.delivery",
      time: RECEIVED_AT,
      datacontenttype: "application/json",
      data: payload,
      oxagenheaders: expect.any(String),
      oxagensha256: bodyDigest(req.body),
    });
    expect("data_base64" in event).toBe(false);
  });

  it("drops the credential headers whatever their case, and lowercases the rest", () => {
    const req = fakeDelivery({
      secret: SECRET,
      deliveryId: "d-7",
      payload: { event: "ping" },
      headers: {
        authorization: "Bearer lowercase-copy",
        Cookie: "session=secret-cookie",
        "Proxy-Authorization": "Basic secret-proxy",
        "X-API-Key": "secret-key",
        "X-Request-Id": "req-9",
      },
    });
    const event = wrap(req);
    expect(storedHeaders(event)).toEqual({
      "content-type": "application/json",
      "x-fake-signature": signBody(SECRET, req.body),
      "x-fake-delivery": "d-7",
      "x-request-id": "req-9",
    });
    for (const secret of [
      "should-not-be-stored",
      "lowercase-copy",
      "secret-cookie",
      "secret-proxy",
      "secret-key",
    ])
      expect(event.oxagenheaders).not.toContain(secret);
  });

  it("reads a +json media type as JSON and records the event as application/json", () => {
    const contentType = "application/vnd.api+json; charset=utf-8";
    const event = wrap(request({ "Content-Type": contentType }, '{"data":{"id":"7"}}'));
    expect(event.data).toEqual({ data: { id: "7" } });
    // The provider's own media type survives only in the stored headers.
    expect(event.datacontenttype).toBe("application/json");
    expect(storedHeaders(event)).toEqual({ "content-type": contentType });
    expect(event.data_base64).toBeUndefined();
  });

  it("reads the JSON media type whatever its case and parameters", () => {
    const event = wrap(request({ "content-type": "Application/JSON; charset=UTF-8" }, "[1,2]"));
    expect(event.data).toEqual([1, 2]);
    expect(event.datacontenttype).toBe("application/json");
  });

  it("keeps a body that does not parse under a JSON type as base64, with the header's type", () => {
    const event = wrap(
      request({ "content-type": "application/json; charset=utf-8" }, "not json{"),
    );
    expect(event.datacontenttype).toBe("application/json; charset=utf-8");
    expect(event.data_base64).toBe(base64Of("not json{"));
    expect("data" in event).toBe(false);
  });

  it("keeps a JSON-looking body under a type that is not JSON as base64", () => {
    const event = wrap(request({ "content-type": "text/plain" }, '{"a":1}'));
    expect(event.datacontenttype).toBe("text/plain");
    expect(event.data_base64).toBe(base64Of('{"a":1}'));
    expect("data" in event).toBe(false);
  });

  it("stores a body with no content type that does not parse as octet-stream", () => {
    const event = wrap(request({}, "hello"));
    expect(event.datacontenttype).toBe("application/octet-stream");
    expect(event.data_base64).toBe("aGVsbG8=");
    expect("data" in event).toBe(false);
  });

  it("stores an empty body with no content type as empty octet-stream", () => {
    const event = wrap(request({}, ""));
    expect(event.datacontenttype).toBe("application/octet-stream");
    expect(event.data_base64).toBe("");
    expect(event.oxagensha256).toBe(EMPTY_SHA256);
    expect(storedHeaders(event)).toEqual({});
  });

  it("reads a body with no content type as JSON when it parses", () => {
    const object = wrap(request({}, '{"a":1}'));
    expect(object.data).toEqual({ a: 1 });
    expect(object.datacontenttype).toBe("application/json");
    const number = wrap(request({}, "42"));
    expect(number.data).toBe(42);
    expect(number.datacontenttype).toBe("application/json");
  });

  it("keeps bytes that are not UTF-8 exactly", () => {
    const raw = [0xff, 0x00, 0x80, 0x41];
    const event = wrap(
      request({ "content-type": "application/octet-stream" }, new Uint8Array(raw)),
    );
    expect(event.datacontenttype).toBe("application/octet-stream");
    expect(event.data_base64).toBe(base64Of(raw));
    expect(event.oxagensha256).toBe(bodyDigest(new Uint8Array(raw)));
  });
});

describe("resultCloudEvent", () => {
  it("wraps a reconcile result as JSON data with no delivery attributes", () => {
    const event = resultCloudEvent({
      collectorId: "col-1",
      key: "reconcile:col-1:1",
      type: COLLECTOR_RECONCILE_TYPE,
      time: RECEIVED_AT,
      data: { missed: 2, fetched: 5 },
    });
    expect(event).toStrictEqual({
      specversion: "1.0",
      id: "reconcile:col-1:1",
      source: "/work/collectors/col-1",
      type: "sh.oxagen.work.collector.reconcile",
      time: RECEIVED_AT,
      datacontenttype: "application/json",
      data: { missed: 2, fetched: 5 },
    });
  });

  it("wraps a nightly count result under the count type", () => {
    const event = resultCloudEvent({
      collectorId: "col-2",
      key: "count:col-2:2026-09-29",
      type: COLLECTOR_COUNT_TYPE,
      time: RECEIVED_AT,
      data: { differed: false },
    });
    expect(event.type).toBe("sh.oxagen.work.collector.count");
    expect(event.id).toBe("count:col-2:2026-09-29");
    expect(event.source).toBe("/work/collectors/col-2");
    expect(event.data).toEqual({ differed: false });
  });
});

describe("requestFromCloudEvent", () => {
  it("rebuilds the body from data_base64 byte for byte, with the stored headers and time", () => {
    const req = requestFromCloudEvent(
      storedEvent({
        data_base64: base64Of([0xff, 0x00, 0x80]),
        oxagenheaders: '{"content-type":"application/octet-stream"}',
      }),
    );
    expect(req.body).toBeInstanceOf(Uint8Array);
    expect([...req.body]).toEqual([0xff, 0x00, 0x80]);
    expect(req.headers).toEqual({ "content-type": "application/octet-stream" });
    expect(req.receivedAt).toBe(RECEIVED_AT);
  });

  it("rebuilds a JSON body as its compact JSON text", () => {
    const req = requestFromCloudEvent(
      storedEvent({ data: { event: "item.changed", ids: ["1"] } }),
    );
    expect(textOf(req.body)).toBe('{"event":"item.changed","ids":["1"]}');
  });

  it("prefers data_base64 when the event carries both", () => {
    const req = requestFromCloudEvent(
      storedEvent({ data: { a: 1 }, data_base64: base64Of("raw") }),
    );
    expect(textOf(req.body)).toBe("raw");
  });

  it("gives an empty body when the event carries no data", () => {
    const req = requestFromCloudEvent(storedEvent({}));
    expect(req.body).toBeInstanceOf(Uint8Array);
    expect(req.body.length).toBe(0);
  });

  it("gives no headers when the event stores none", () => {
    expect(requestFromCloudEvent(storedEvent({ data: {} })).headers).toEqual({});
  });

  it("gives no headers when the stored headers are JSON but not an object", () => {
    for (const oxagenheaders of ['"text"', "null", "42", "true", '["x"]'])
      expect(requestFromCloudEvent(storedEvent({ oxagenheaders })).headers).toEqual({});
  });

  it("throws when the stored headers are not JSON", () => {
    expect(() => requestFromCloudEvent(storedEvent({ oxagenheaders: "{" }))).toThrow(
      SyntaxError,
    );
  });
});

describe("the round trip through a stored delivery", () => {
  it("gives back the body of a compact JSON delivery and the headers it kept", () => {
    const req = fakeDelivery({
      secret: SECRET,
      deliveryId: "d-3",
      payload: { event: "item.changed", ids: ["101"] },
      headers: { Cookie: "session=1", "X-Request-Id": "req-3" },
    });
    const event = wrap(req);
    const back = requestFromCloudEvent(event);
    expect(textOf(back.body)).toBe(textOf(req.body));
    expect(bodyDigest(back.body)).toBe(event.oxagensha256);
    expect(back.headers).toEqual({
      "content-type": "application/json",
      "x-fake-signature": signBody(SECRET, req.body),
      "x-fake-delivery": "d-3",
      "x-request-id": "req-3",
    });
    expect(back.receivedAt).toBe(req.receivedAt);
  });

  it("gives back a body that is not JSON byte for byte", () => {
    const req = request({ "content-type": "text/plain" }, new Uint8Array([0x68, 0x69, 0xff]));
    const back = requestFromCloudEvent(wrap(req));
    expect([...back.body]).toEqual([0x68, 0x69, 0xff]);
    expect(back.headers).toEqual({ "content-type": "text/plain" });
  });

  it("keeps JSON that is not compact as base64, so the rebuilt body matches the digest", () => {
    const req = request({ "content-type": "application/json" }, '{ "a": 1 }');
    const event = wrap(req);
    expect("data" in event).toBe(false);
    expect(event.datacontenttype).toBe("application/json");
    const back = requestFromCloudEvent(event);
    expect(textOf(back.body)).toBe('{ "a": 1 }');
    expect(bodyDigest(back.body)).toBe(event.oxagensha256);
  });

  it("keeps an integer above 2^53 exactly", () => {
    const req = request({ "content-type": "application/json" }, '{"id":9007199254740993}');
    const event = wrap(req);
    expect("data" in event).toBe(false);
    expect(textOf(requestFromCloudEvent(event).body)).toBe('{"id":9007199254740993}');
  });
});
