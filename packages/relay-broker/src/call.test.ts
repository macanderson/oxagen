// call.ts: one call from the request frame to the last frame of its response.
import { TransportError } from "@oxagen/mcp-studio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChunkQueue,
  GRPC_CANCELLED,
  GRPC_DEADLINE_EXCEEDED,
  GRPC_RESOURCE_EXHAUSTED,
  GRPC_UNAVAILABLE,
  RelayCall,
  type CallOptions,
} from "./call";
import { toBase64 } from "./protocol/frames";

function makeCall(overrides: Partial<CallOptions> = {}) {
  const controller = new AbortController();
  const sendCancel = vi.fn();
  const onSettled = vi.fn();
  const call = new RelayCall({
    id: "c1",
    kind: "http",
    relay: "office",
    deadlineMs: 1_000,
    graceMs: 200,
    signal: controller.signal,
    sendCancel,
    onSettled,
    ...overrides,
  });
  return { call, controller, sendCancel, onSettled };
}

function chunk(text: string): string {
  return toBase64(new TextEncoder().encode(text));
}

async function readText(parts: AsyncIterable<Uint8Array>): Promise<string> {
  const buffers: Buffer[] = [];
  for await (const part of parts) buffers.push(Buffer.from(part));
  return Buffer.concat(buffers).toString("utf8");
}

async function readAll(parts: AsyncIterable<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const part of parts) out.push(Buffer.from(part).toString("utf8"));
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("an HTTP call", () => {
  it("resolves the head, streams the body, and settles on end", async () => {
    const { call, onSettled } = makeCall();
    call.receive({ type: "head", id: "c1", status: 201, headers: [["content-type", "text/plain"]] });
    call.receive({ type: "data", id: "c1", chunk: chunk("hello, ") });
    call.receive({ type: "data", id: "c1", chunk: chunk("relay") });
    call.receive({ type: "end", id: "c1" });
    await expect(call.head).resolves.toStrictEqual({ status: 201, headers: [["content-type", "text/plain"]] });
    await expect(readText(call.body.read())).resolves.toBe("hello, relay");
    await expect(call.status()).resolves.toStrictEqual({ code: 0, message: "", metadata: [] });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("drops data before the head and a second head", async () => {
    const { call } = makeCall();
    call.receive({ type: "data", id: "c1", chunk: chunk("early") });
    call.receive({ type: "head", id: "c1", status: 200, headers: [] });
    call.receive({ type: "head", id: "c1", status: 500, headers: [] });
    call.receive({ type: "data", id: "c1", chunk: chunk("body") });
    call.receive({ type: "end", id: "c1" });
    await expect(call.head).resolves.toMatchObject({ status: 200 });
    await expect(readText(call.body.read())).resolves.toBe("body");
  });

  it("drops every frame after it settles", async () => {
    const { call, onSettled } = makeCall();
    call.receive({ type: "head", id: "c1", status: 200, headers: [] });
    call.receive({ type: "end", id: "c1" });
    call.receive({ type: "data", id: "c1", chunk: chunk("late") });
    call.receive({ type: "fail", id: "c1", code: "upstream", message: "late", sent: true });
    call.disconnected();
    call.cancel();
    await expect(readText(call.body.read())).resolves.toBe("");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("throws a failure after the head from the body", async () => {
    const { call } = makeCall();
    call.receive({ type: "head", id: "c1", status: 200, headers: [] });
    call.receive({ type: "data", id: "c1", chunk: chunk("part") });
    call.receive({ type: "fail", id: "c1", code: "too_large", message: "over the cap", sent: true });
    const parts: string[] = [];
    await expect(
      (async () => {
        for await (const part of call.body.read()) parts.push(Buffer.from(part).toString("utf8"));
      })(),
    ).rejects.toThrow(/too_large/);
    expect(parts).toStrictEqual(["part"]);
  });

  it("rejects a call the relay ended before any head", async () => {
    const { call } = makeCall();
    call.receive({ type: "end", id: "c1" });
    await expect(call.head).rejects.toThrow(/before it sent a response head/);
    await expect(call.status()).resolves.toMatchObject({ code: GRPC_UNAVAILABLE });
  });
});

describe("a refusal", () => {
  it("reports a host the allowlist does not name as refused_host, not sent", async () => {
    const { call } = makeCall();
    call.receive({ type: "refused", id: "c1", code: "host_not_allowed", message: "db.internal is not listed" });
    const error = await call.head.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ code: "refused_host", sent: false });
    expect((error as Error).message).toContain("host_not_allowed");
  });

  it.each(["unsigned", "expired", "replayed", "wrong_workspace", "bad_signature"] as const)(
    "reports %s as not_sent",
    async (code) => {
      const { call } = makeCall();
      call.receive({ type: "refused", id: "c1", code, message: "refused" });
      await expect(call.head).rejects.toMatchObject({ code: "not_sent", sent: false });
      await expect(call.status()).resolves.toMatchObject({ code: GRPC_UNAVAILABLE });
    },
  );
});

describe("a failure the relay reports", () => {
  it("is a timeout with the relay's sent flag", async () => {
    const { call } = makeCall();
    call.receive({ type: "fail", id: "c1", code: "timeout", message: "30000 ms", sent: true });
    await expect(call.head).rejects.toMatchObject({ code: "timeout", sent: true });
  });

  it("is not_sent when the relay says nothing left", async () => {
    const { call } = makeCall();
    call.receive({ type: "fail", id: "c1", code: "upstream", message: "connection refused", sent: false });
    await expect(call.head).rejects.toMatchObject({ code: "not_sent", sent: false });
  });

  it("is a plain error when the upstream may have the request", async () => {
    const { call } = makeCall();
    call.receive({ type: "fail", id: "c1", code: "upstream", message: "reset", sent: true });
    const error = await call.head.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransportError);
  });
});

describe("a gRPC call", () => {
  it("yields each message and ends with the trailers' status", async () => {
    const { call } = makeCall({ kind: "grpc" });
    call.receive({ type: "head", id: "c1", status: 200, headers: [["x-served-by", "ledger-1"]] });
    call.receive({ type: "data", id: "c1", chunk: chunk("m1") });
    call.receive({ type: "data", id: "c1", chunk: chunk("m2") });
    call.receive({ type: "trailers", id: "c1", code: 5, message: "not found", metadata: [["x-a", "b"]] });
    await expect(readAll(call.body.read())).resolves.toStrictEqual(["m1", "m2"]);
    await expect(call.status()).resolves.toStrictEqual({ code: 5, message: "not found", metadata: [["x-a", "b"]] });
  });

  it("ends its messages quietly on a failure after the head and reports it in the status", async () => {
    const { call } = makeCall({ kind: "grpc" });
    call.receive({ type: "head", id: "c1", status: 200, headers: [] });
    call.receive({ type: "data", id: "c1", chunk: chunk("m1") });
    call.receive({ type: "fail", id: "c1", code: "too_large", message: "over the cap", sent: true });
    await expect(readAll(call.body.read())).resolves.toStrictEqual(["m1"]);
    await expect(call.status()).resolves.toStrictEqual({ code: GRPC_RESOURCE_EXHAUSTED, message: "over the cap", metadata: [] });
  });

  it("maps a cancelled failure to CANCELLED", async () => {
    const { call } = makeCall({ kind: "grpc" });
    call.receive({ type: "head", id: "c1", status: 200, headers: [] });
    call.receive({ type: "fail", id: "c1", code: "cancelled", message: "stopped", sent: true });
    await expect(call.status()).resolves.toMatchObject({ code: GRPC_CANCELLED });
  });
});

describe("the deadline", () => {
  it("times out after deadline_ms and the grace, cancels at the relay, and says it may have been sent", async () => {
    const { call, sendCancel, onSettled } = makeCall({ deadlineMs: 1_000, graceMs: 200 });
    vi.advanceTimersByTime(1_199);
    expect(sendCancel).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sendCancel).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    await expect(call.head).rejects.toMatchObject({ code: "timeout", sent: true });
    await expect(call.status()).resolves.toMatchObject({ code: GRPC_DEADLINE_EXCEEDED });
  });

  it("stops once the call settles", () => {
    const { call, sendCancel } = makeCall();
    call.receive({ type: "head", id: "c1", status: 200, headers: [] });
    call.receive({ type: "end", id: "c1" });
    vi.advanceTimersByTime(10_000);
    expect(sendCancel).not.toHaveBeenCalled();
  });
});

describe("a lost connection", () => {
  it("rejects as disconnected, sent", async () => {
    const { call } = makeCall();
    call.disconnected();
    await expect(call.head).rejects.toMatchObject({ code: "disconnected", sent: true });
  });

  it("throws from an HTTP body already streaming", async () => {
    const { call } = makeCall();
    call.receive({ type: "head", id: "c1", status: 200, headers: [] });
    call.disconnected();
    await expect(readText(call.body.read())).rejects.toMatchObject({ code: "disconnected" });
  });
});

describe("a cancel", () => {
  it("from the caller's cancel() tells the relay and drops what is queued", async () => {
    const { call, sendCancel, onSettled } = makeCall({ kind: "grpc" });
    call.receive({ type: "head", id: "c1", status: 200, headers: [] });
    call.receive({ type: "data", id: "c1", chunk: chunk("m1") });
    call.cancel();
    expect(sendCancel).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
    await expect(readAll(call.body.read())).resolves.toStrictEqual([]);
    await expect(call.status()).resolves.toMatchObject({ code: GRPC_CANCELLED });
  });

  it("from the caller's signal tells the relay and rejects with a plain error", async () => {
    const { call, controller, sendCancel } = makeCall();
    controller.abort();
    expect(sendCancel).toHaveBeenCalledTimes(1);
    const error = await call.head.catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(TransportError);
    expect((error as Error).message).toMatch(/cancelled after it was sent/);
  });

  it("from the signal after the call settled does nothing", () => {
    const { call, controller, sendCancel } = makeCall();
    call.receive({ type: "head", id: "c1", status: 200, headers: [] });
    call.receive({ type: "end", id: "c1" });
    controller.abort();
    expect(sendCancel).not.toHaveBeenCalled();
  });
});

describe("ChunkQueue", () => {
  it("wakes a waiting reader when a part arrives", async () => {
    const queue = new ChunkQueue();
    const reading = readAll(queue.read());
    await Promise.resolve();
    queue.push(new TextEncoder().encode("a"));
    queue.push(new TextEncoder().encode("b"));
    queue.end();
    await expect(reading).resolves.toStrictEqual(["a", "b"]);
  });

  it("ignores parts after the end", async () => {
    const queue = new ChunkQueue();
    queue.end();
    queue.push(new TextEncoder().encode("late"));
    await expect(readAll(queue.read())).resolves.toStrictEqual([]);
  });

  it("gives the queued parts before it throws the error", async () => {
    const queue = new ChunkQueue();
    queue.push(new TextEncoder().encode("a"));
    queue.end(new Error("broke"));
    const parts: string[] = [];
    await expect(
      (async () => {
        for await (const part of queue.read()) parts.push(Buffer.from(part).toString("utf8"));
      })(),
    ).rejects.toThrow("broke");
    expect(parts).toStrictEqual(["a"]);
  });
});
