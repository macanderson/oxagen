// sink.test.ts: FrameSink, which turns an upstream response into frames the broker accepts, one terminal frame per call.
import {
  decodeRelayFrame,
  encodeFrame,
  MAX_FRAME_BYTES,
  toBase64,
  type RelayFrame,
} from "@oxagen/relay-broker/protocol";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HeaderEntry } from "./credentials";
import { BUFFER_HIGH_WATER, BUFFER_LOW_WATER, clip, FrameSink, MAX_GRPC_MESSAGE_BYTES } from "./sink";

const ID = "call-1";

interface Harness {
  sink: FrameSink;
  /** Every frame the sink sent, in order. */
  frames: RelayFrame[];
  onDone: Mock<() => void>;
  /** Set the bytes the connection reports as queued. */
  setQueued(bytes: number): void;
}

/**
 * A sink whose send checks each frame against the broker's own schema, so
 * every test also proves the broker would accept what the sink sent.
 */
function harness(maxResponseBytes = 1024): Harness {
  const frames: RelayFrame[] = [];
  let queued = 0;
  const onDone = vi.fn<() => void>();
  const sink = new FrameSink({
    id: ID,
    send(frame) {
      const text = encodeFrame(frame);
      if (decodeRelayFrame(text) === undefined) {
        throw new Error(`The broker would drop this frame: ${text.slice(0, 200)}`);
      }
      frames.push(frame);
    },
    buffered: () => queued,
    maxResponseBytes,
    onDone,
  });
  return {
    sink,
    frames,
    onDone,
    setQueued: (bytes) => {
      queued = bytes;
    },
  };
}

type FrameOf<T extends RelayFrame["type"]> = Extract<RelayFrame, { type: T }>;

/** The frames of one type. */
function only<T extends RelayFrame["type"]>(frames: readonly RelayFrame[], type: T): FrameOf<T>[] {
  return frames.filter((frame): frame is FrameOf<T> => frame.type === type);
}

/** A promise's state, readable without awaiting it. */
function track<T>(promise: Promise<T>): { readonly settled: boolean; readonly value: T | undefined } {
  const state: { settled: boolean; value: T | undefined } = { settled: false, value: undefined };
  void promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

function entries(count: number): HeaderEntry[] {
  return Array.from({ length: count }, (_, index): HeaderEntry => [`x-h-${index}`, "v"]);
}

function failFrame(code: FrameOf<"fail">["code"], message: string): FrameOf<"fail"> {
  return { type: "fail", id: ID, code, message, sent: true };
}

const HEAD_200: FrameOf<"head"> = { type: "head", id: ID, status: 200, headers: [] };

const HEADERS_TOO_LARGE = "The upstream's response headers are larger than the relay can carry.";
const TRAILERS_TOO_LARGE = "The upstream's gRPC trailers are larger than the relay can carry.";

const fitting: [string, HeaderEntry[]][] = [
  ["1024 entries", entries(1024)],
  ["a name of 256 characters", [["x".repeat(256), "v"]]],
  ["a value of 65536 characters", [["x-big", "v".repeat(65_536)]]],
  ["an empty value", [["x-empty", ""]]],
];

const oversized: [string, HeaderEntry[]][] = [
  ["1025 entries", entries(1025)],
  ["a name of 257 characters", [["x".repeat(257), "v"]]],
  ["a value of 65537 characters", [["x-big", "v".repeat(65_537)]]],
  ["an empty name", [["", "v"]]],
];

describe("FrameSink.head", () => {
  it("sends the status and headers", () => {
    const h = harness();

    h.sink.head(201, [["content-type", "application/json"]]);

    expect(h.frames).toEqual([{ type: "head", id: ID, status: 201, headers: [["content-type", "application/json"]] }]);
    expect(h.sink.closed).toBe(false);
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it.each([100, 599])("accepts status %d", (status) => {
    const h = harness();

    h.sink.head(status, []);

    expect(h.frames).toEqual([{ ...HEAD_200, status }]);
  });

  it.each([99, 600, 200.5, Number.NaN])("fails the call as an upstream fault for status %d", (status) => {
    const h = harness();

    h.sink.head(status, []);

    expect(h.frames).toEqual([
      failFrame("upstream", `The upstream answered with status ${status}, which is not an HTTP status.`),
    ]);
    expect(h.sink.closed).toBe(true);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it.each(fitting)("sends headers with %s", (_label, headers) => {
    const h = harness();

    h.sink.head(200, headers);

    expect(h.frames).toEqual([{ ...HEAD_200, headers }]);
  });

  it.each(oversized)("fails the call as too large for headers with %s", (_label, headers) => {
    const h = harness();

    h.sink.head(200, headers);

    expect(h.frames).toEqual([failFrame("too_large", HEADERS_TOO_LARGE)]);
    expect(h.sink.closed).toBe(true);
  });

  it("sends only the first head", () => {
    const h = harness();

    h.sink.head(200, []);
    h.sink.head(500, [["x-late", "1"]]);

    expect(h.frames).toEqual([HEAD_200]);
  });
});

describe("FrameSink.data", () => {
  it("sends the chunk as base64 and asks for more", async () => {
    const h = harness();
    h.sink.head(200, []);

    await expect(h.sink.data(Uint8Array.from([1, 2, 3]))).resolves.toBe(true);

    expect(h.frames).toEqual([HEAD_200, { type: "data", id: ID, chunk: "AQID" }]);
  });

  it("sends and counts a view by its own bytes, not the buffer behind it", async () => {
    const h = harness(3);
    h.sink.head(200, []);
    const view = Uint8Array.from([9, 1, 2, 3, 9]).subarray(1, 4);

    await expect(h.sink.data(view)).resolves.toBe(true);

    expect(only(h.frames, "data")).toEqual([{ type: "data", id: ID, chunk: "AQID" }]);
    expect(h.sink.closed).toBe(false);
  });

  it("fails the call as an upstream fault for a body before the head", async () => {
    const h = harness();

    await expect(h.sink.data(Uint8Array.from([1]))).resolves.toBe(false);

    expect(h.frames).toEqual([failFrame("upstream", "The upstream sent a body before its response head.")]);
  });

  it("allows a response of exactly the cap", async () => {
    const h = harness(4);
    h.sink.head(200, []);

    await expect(h.sink.data(new Uint8Array(2))).resolves.toBe(true);
    await expect(h.sink.data(new Uint8Array(2))).resolves.toBe(true);

    expect(only(h.frames, "data")).toHaveLength(2);
    expect(h.sink.closed).toBe(false);
  });

  it("fails the call as too large once the response passes the cap, without sending that chunk", async () => {
    const h = harness(4);
    h.sink.head(200, []);
    await h.sink.data(new Uint8Array(3));

    await expect(h.sink.data(new Uint8Array(2))).resolves.toBe(false);

    expect(only(h.frames, "data")).toHaveLength(1);
    expect(h.frames.at(-1)).toEqual(
      failFrame("too_large", "The response passed the relay's cap of 4 bytes (RELAY_MAX_RESPONSE_BYTES)."),
    );
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("sends nothing and answers false after the call ends", async () => {
    const h = harness();
    h.sink.head(200, []);
    h.sink.end();
    const sent = h.frames.length;

    await expect(h.sink.data(Uint8Array.from([1]))).resolves.toBe(false);

    expect(h.frames).toHaveLength(sent);
  });

  it("leaves room for the frame around the largest gRPC message", () => {
    const frame: RelayFrame = {
      type: "data",
      id: "x".repeat(64),
      chunk: toBase64(new Uint8Array(MAX_GRPC_MESSAGE_BYTES)),
    };

    expect(encodeFrame(frame).length).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });
});

describe("FrameSink.data backpressure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not wait while the queue is at the high-water mark", async () => {
    const h = harness();
    h.sink.head(200, []);
    h.setQueued(BUFFER_HIGH_WATER);

    await expect(h.sink.data(Uint8Array.from([1]))).resolves.toBe(true);
  });

  it("sends the chunk, then waits until the queue falls to the low-water mark", async () => {
    const h = harness();
    h.sink.head(200, []);
    h.setQueued(BUFFER_HIGH_WATER + 1);

    const result = track(h.sink.data(Uint8Array.from([1])));
    // The chunk goes out before the wait starts.
    expect(only(h.frames, "data")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20);
    expect(result.settled).toBe(false);

    h.setQueued(BUFFER_LOW_WATER + 1);
    await vi.advanceTimersByTimeAsync(20);
    expect(result.settled).toBe(false);

    h.setQueued(BUFFER_LOW_WATER);
    await vi.advanceTimersByTimeAsync(20);
    expect(result).toEqual({ settled: true, value: true });
  });

  it("answers false when the call is closed during the wait", async () => {
    const h = harness();
    h.sink.head(200, []);
    h.setQueued(BUFFER_HIGH_WATER + 1);
    const result = track(h.sink.data(Uint8Array.from([1])));

    h.sink.close();
    await vi.advanceTimersByTimeAsync(20);

    expect(result).toEqual({ settled: true, value: false });
  });

  it("answers false when the call fails during the wait", async () => {
    const h = harness();
    h.sink.head(200, []);
    h.setQueued(BUFFER_HIGH_WATER + 1);
    const result = track(h.sink.data(Uint8Array.from([1])));

    h.sink.fail("timeout", "The call passed its deadline.", true);
    await vi.advanceTimersByTimeAsync(20);

    expect(result).toEqual({ settled: true, value: false });
    expect(h.frames.at(-1)).toEqual(failFrame("timeout", "The call passed its deadline."));
  });
});

describe("FrameSink.end", () => {
  it("sends an end frame after the head and runs onDone once", () => {
    const h = harness();
    h.sink.head(200, []);

    h.sink.end();

    expect(h.frames).toEqual([HEAD_200, { type: "end", id: ID }]);
    expect(h.sink.closed).toBe(true);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("fails the call as an upstream fault when the response ends before its head", () => {
    const h = harness();

    h.sink.end();

    expect(h.frames).toEqual([failFrame("upstream", "The upstream ended the response before its head.")]);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });
});

describe("FrameSink.trailers", () => {
  it("sends a head of 200 first when the call has none", () => {
    const h = harness();

    h.sink.trailers(0, "", [["x-trace-id", "t-1"]]);

    expect(h.frames).toEqual([
      HEAD_200,
      { type: "trailers", id: ID, code: 0, message: "", metadata: [["x-trace-id", "t-1"]] },
    ]);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("sends only the trailers when the head went out already", () => {
    const h = harness();
    h.sink.head(200, [["content-type", "application/grpc"]]);

    h.sink.trailers(5, "no such entry", []);

    expect(only(h.frames, "head")).toHaveLength(1);
    expect(h.frames.at(-1)).toEqual({ type: "trailers", id: ID, code: 5, message: "no such entry", metadata: [] });
  });

  it.each([0, 16])("keeps gRPC code %d", (code) => {
    const h = harness();

    h.sink.trailers(code, "", []);

    expect(only(h.frames, "trailers")[0]?.code).toBe(code);
  });

  it.each([-1, 17, 1.5, Number.NaN])("sends gRPC code %d as 2, UNKNOWN", (code) => {
    const h = harness();

    h.sink.trailers(code, "", []);

    expect(only(h.frames, "trailers")[0]?.code).toBe(2);
  });

  it.each(oversized)("fails the call as too large for trailers with %s, and sends no head", (_label, metadata) => {
    const h = harness();

    h.sink.trailers(0, "", metadata);

    expect(h.frames).toEqual([failFrame("too_large", TRAILERS_TOO_LARGE)]);
  });

  it("cuts a long message to 4096 characters", () => {
    const h = harness();

    h.sink.trailers(13, "x".repeat(5000), []);

    expect(only(h.frames, "trailers")[0]?.message).toBe(`${"x".repeat(4093)}...`);
  });

  it("keeps a message of exactly 4096 characters whole", () => {
    const h = harness();

    h.sink.trailers(13, "x".repeat(4096), []);

    expect(only(h.frames, "trailers")[0]?.message).toBe("x".repeat(4096));
  });
});

describe("FrameSink.fail", () => {
  it("sends the code, the message, and whether the upstream may have the request", () => {
    const h = harness();

    h.sink.fail("timeout", "The call passed its deadline.", false);

    expect(h.frames).toEqual([
      { type: "fail", id: ID, code: "timeout", message: "The call passed its deadline.", sent: false },
    ]);
    expect(h.sink.closed).toBe(true);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("cuts a long message to 2048 characters", () => {
    const h = harness();

    h.sink.fail("upstream", "x".repeat(3000), true);

    expect(only(h.frames, "fail")[0]?.message).toBe(`${"x".repeat(2045)}...`);
  });
});

describe("FrameSink terminal frame", () => {
  const finishers: [string, (sink: FrameSink) => void][] = [
    ["end", (sink) => sink.end()],
    ["fail", (sink) => sink.fail("upstream", "The upstream closed the connection.", true)],
    ["trailers", (sink) => sink.trailers(0, "", [])],
  ];

  it.each(finishers)("sends nothing after %s", async (_label, finish) => {
    const h = harness();
    h.sink.head(200, []);
    finish(h.sink);
    const sent = h.frames.length;

    h.sink.end();
    h.sink.fail("cancelled", "The broker cancelled the call.", false);
    h.sink.trailers(0, "", []);
    h.sink.head(200, []);
    h.sink.close();
    await expect(h.sink.data(Uint8Array.from([1]))).resolves.toBe(false);

    expect(h.frames).toHaveLength(sent);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.sink.closed).toBe(true);
  });
});

describe("FrameSink.close", () => {
  it("ends the call without a frame and runs onDone once", async () => {
    const h = harness();
    h.sink.head(200, []);
    expect(h.sink.closed).toBe(false);

    h.sink.close();
    h.sink.close();
    h.sink.end();
    h.sink.fail("cancelled", "The broker cancelled the call.", false);
    await expect(h.sink.data(Uint8Array.from([1]))).resolves.toBe(false);

    expect(h.frames).toEqual([HEAD_200]);
    expect(h.sink.closed).toBe(true);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("sends no frame when the call closes before anything was sent", () => {
    const h = harness();

    h.sink.close();

    expect(h.frames).toEqual([]);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });
});

describe("clip", () => {
  it("leaves text at or under the limit unchanged", () => {
    expect(clip("short", 8)).toBe("short");
    expect(clip("abcdefgh", 8)).toBe("abcdefgh");
  });

  it("cuts longer text so the result, with its three dots, is exactly the limit", () => {
    expect(clip("abcdefghij", 8)).toBe("abcde...");
  });

  it("drops a whole emoji rather than half of its surrogate pair", () => {
    // U+1F600 is two UTF-16 code units, at indexes 4 and 5.
    expect(clip("abcd\u{1F600}fghij", 8)).toBe("abcd...");
  });

  it("keeps an emoji whose surrogate pair ends right at the cut", () => {
    expect(clip("abc\u{1F600}fghij", 8)).toBe("abc\u{1F600}...");
  });
});
