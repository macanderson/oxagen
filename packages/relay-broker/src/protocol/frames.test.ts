// frames.ts: the frames the relay and the broker exchange.
import { describe, expect, it } from "vitest";
import {
  decodeBrokerFrame,
  decodeRelayFrame,
  encodeFrame,
  fromBase64,
  RELAY_PROTOCOL_VERSION,
  toBase64,
  type BrokerFrame,
  type RelayFrame,
} from "./frames";

const brokerFrames: BrokerFrame[] = [
  { type: "welcome", protocol: RELAY_PROTOCOL_VERSION, heartbeat_ms: 20_000 },
  { type: "request", id: "c1", envelope: { schema: "relay-envelope/v1" }, headers: [["accept", "*/*"]], body: "e30=" },
  { type: "cancel", id: "c1" },
  { type: "hb_ack" },
];

const relayFrames: RelayFrame[] = [
  { type: "hello", protocol: RELAY_PROTOCOL_VERSION, relay: "office", workspace: "wrk_abc", version: "2.1.3" },
  { type: "hb" },
  { type: "refused", id: "c1", code: "host_not_allowed", message: "db.internal is not on the allowlist" },
  { type: "head", id: "c1", status: 200, headers: [["content-type", "text/plain"]] },
  { type: "data", id: "c1", chunk: "aGk=" },
  { type: "end", id: "c1" },
  { type: "trailers", id: "c1", code: 0, message: "", metadata: [] },
  { type: "fail", id: "c1", code: "too_large", message: "over 10 MiB", sent: true },
];

describe("broker frames", () => {
  it.each(brokerFrames.map((frame) => [frame.type, frame] as const))("round-trips %s", (_type, frame) => {
    expect(decodeBrokerFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("reads a relay frame as no broker frame", () => {
    expect(decodeBrokerFrame(encodeFrame({ type: "hb" }))).toBeUndefined();
  });
});

describe("relay frames", () => {
  it.each(relayFrames.map((frame) => [frame.type, frame] as const))("round-trips %s", (_type, frame) => {
    expect(decodeRelayFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("reads a broker frame as no relay frame", () => {
    expect(decodeRelayFrame(encodeFrame({ type: "hb_ack" }))).toBeUndefined();
  });
});

describe("unreadable frames", () => {
  it.each([
    ["text that is not JSON", "{not json"],
    ["an unknown type", JSON.stringify({ type: "shutdown" })],
    ["an extra field", JSON.stringify({ type: "hb", extra: 1 })],
    ["another protocol version", JSON.stringify({ type: "hello", protocol: 2, relay: "a", workspace: "wrk_a", version: "" })],
    ["a body that is not base64", JSON.stringify({ type: "data", id: "c1", chunk: "not base64!" })],
    ["an empty call id", JSON.stringify({ type: "end", id: "" })],
    ["a status out of range", JSON.stringify({ type: "head", id: "c1", status: 42, headers: [] })],
    ["an unknown refusal code", JSON.stringify({ type: "refused", id: "c1", code: "nope", message: "" })],
  ])("refuses %s", (_label, text) => {
    expect(decodeRelayFrame(text)).toBeUndefined();
    expect(decodeBrokerFrame(text)).toBeUndefined();
  });
});

describe("base64", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("encodes only the view, not the whole buffer behind it", () => {
    const whole = new Uint8Array([9, 9, 1, 2, 3, 9]);
    expect(toBase64(whole.subarray(2, 5))).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("encodes no bytes as the empty string", () => {
    expect(toBase64(new Uint8Array())).toBe("");
    expect(fromBase64("")).toEqual(new Uint8Array());
  });
});
