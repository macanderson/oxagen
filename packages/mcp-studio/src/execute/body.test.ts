// body.ts: reading a response inside the deadline, and the text helpers.
import { describe, expect, it, vi } from "vitest";
import {
  MAX_BODY_BYTES,
  SseParser,
  concat,
  decodeText,
  encodeText,
  isJsonMediaType,
  parseJson,
  readBody,
  readChunks,
  transportFailure,
} from "./body";
import { CANCELLED, Clock, deadlineExceeded } from "./retry";
import { TRANSPORT_ERROR_CODES, TransportError, type HttpTransportResponse } from "./transport";

function fakeResponse(body: AsyncIterable<Uint8Array>, status = 200): HttpTransportResponse & { cancel: ReturnType<typeof vi.fn> } {
  return { status, headers: [], body, cancel: vi.fn() };
}

function chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield encodeText(part);
    },
  };
}

function iterable(next: () => Promise<IteratorResult<Uint8Array>>): AsyncIterable<Uint8Array> {
  return { [Symbol.asyncIterator]: () => ({ next }) };
}

function openClock(): Clock {
  return new Clock(Date.now() + 60_000, new AbortController().signal, new AbortController());
}

describe("transportFailure", () => {
  it("titles every Transport error code and keeps whether the request was sent", () => {
    for (const code of TRANSPORT_ERROR_CODES) {
      const failure = transportFailure(new TransportError(code, "detail", false));
      expect(failure.error.title).not.toBe("Transport error");
      expect(failure.error.detail).toBe("detail");
      expect(failure.sent).toBe(false);
    }
    expect(transportFailure(new TransportError("refused_address", "10.0.0.1 is private.", false))).toEqual({
      error: { title: "Address refused", detail: "10.0.0.1 is private.", status: undefined },
      sent: false,
    });
  });

  it("treats any other throw as a failure after the request may have gone out", () => {
    expect(transportFailure(new Error("socket hang up"))).toEqual({
      error: { title: "Transport error", detail: "socket hang up", status: undefined },
      sent: true,
    });
  });
});

describe("readBody", () => {
  it("joins every chunk", async () => {
    const response = fakeResponse(chunks('{"a":', "1}"));
    const clock = openClock();
    const read = await readBody(response, { clock, deadline_ms: 30_000 });
    expect(read).toEqual({ ok: true, bytes: encodeText('{"a":1}') });
    expect(response.cancel).not.toHaveBeenCalled();
    clock.dispose();
  });

  it("stops past the limit and cancels the response", async () => {
    const response = fakeResponse(chunks("ab", "cd"), 502);
    const clock = openClock();
    const read = await readBody(response, { clock, deadline_ms: 30_000, limit: 3 });
    expect(read).toEqual({
      ok: false,
      error: {
        title: "Response too large",
        detail: "The upstream's response passed 3 bytes, the most one call reads.",
        status: 502,
      },
    });
    expect(response.cancel).toHaveBeenCalledTimes(1);
    clock.dispose();
  });

  it("returns a Transport error when the body cannot start", async () => {
    const response = fakeResponse({
      [Symbol.asyncIterator]() {
        throw new TransportError("disconnected", "The relay is not connected.", true);
      },
    });
    const clock = openClock();
    const read = await readBody(response, { clock, deadline_ms: 30_000 });
    expect(read).toEqual({
      ok: false,
      error: { title: "Not connected", detail: "The relay is not connected.", status: undefined },
    });
    expect(response.cancel).toHaveBeenCalledTimes(1);
    clock.dispose();
  });

  it("returns a Transport error when a chunk fails", async () => {
    const response = fakeResponse(iterable(() => Promise.reject(new Error("connection reset"))));
    const clock = openClock();
    const read = await readBody(response, { clock, deadline_ms: 30_000 });
    expect(read).toEqual({
      ok: false,
      error: { title: "Transport error", detail: "connection reset", status: undefined },
    });
    expect(response.cancel).toHaveBeenCalledTimes(1);
    clock.dispose();
  });

  it("stops a body that never ends at the deadline", async () => {
    const response = fakeResponse(iterable(() => new Promise<IteratorResult<Uint8Array>>(() => undefined)));
    const clock = new Clock(Date.now() + 5, new AbortController().signal, new AbortController());
    const read = await readBody(response, { clock, deadline_ms: 5 });
    expect(read).toEqual({ ok: false, error: deadlineExceeded(5) });
    expect(response.cancel).toHaveBeenCalledTimes(1);
    clock.dispose();
  });

  it("stops when the caller cancels", async () => {
    const caller = new AbortController();
    caller.abort();
    const response = fakeResponse(chunks("never read"));
    const clock = new Clock(Date.now() + 60_000, caller.signal, new AbortController());
    const read = await readBody(response, { clock, deadline_ms: 30_000 });
    expect(read).toEqual({ ok: false, error: CANCELLED });
    expect(response.cancel).toHaveBeenCalledTimes(1);
    clock.dispose();
  });

  it("reads up to MAX_BODY_BYTES by default", () => {
    expect(MAX_BODY_BYTES).toBe(16 * 1_048_576);
  });
});

describe("readChunks", () => {
  it("ends the read early when the reader has what it needs", async () => {
    const response = fakeResponse(chunks("first", "second"));
    const clock = openClock();
    const seen: string[] = [];
    const read = await readChunks(response, { clock, deadline_ms: 30_000 }, (chunk) => {
      seen.push(decodeText(chunk));
      return true;
    });
    expect(read).toEqual({ ok: true });
    expect(seen).toEqual(["first"]);
    expect(response.cancel).toHaveBeenCalledTimes(1);
    clock.dispose();
  });
});

describe("text helpers", () => {
  it("joins chunks into a new array", () => {
    expect(concat([])).toEqual(new Uint8Array(0));
    const one = encodeText("ab");
    const joined = concat([one]);
    expect(joined).toEqual(one);
    expect(joined).not.toBe(one);
    expect(decodeText(concat([encodeText("ab"), encodeText("cd")]))).toBe("abcd");
  });

  it("decodes UTF-8, drops a byte order mark, and replaces a bad sequence", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("a");
    expect(decodeText(new Uint8Array([0xff]))).toBe("�");
    expect(decodeText(encodeText("réfund"))).toBe("réfund");
  });

  it("parses JSON or returns the parser's message", () => {
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    const failed = parseJson("{");
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.message.length).toBeGreaterThan(0);
  });

  it("recognizes JSON media types", () => {
    expect(isJsonMediaType(undefined)).toBe(false);
    expect(isJsonMediaType("application/json")).toBe(true);
    expect(isJsonMediaType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonMediaType(" Application/Problem+JSON ")).toBe(true);
    expect(isJsonMediaType("text/plain")).toBe(false);
    expect(isJsonMediaType("text/event-stream")).toBe(false);
  });
});

describe("SseParser", () => {
  it("reads an event with its name and data", () => {
    const parser = new SseParser();
    expect(parser.push('event: result\ndata: {"a":1}\n\n')).toEqual([{ event: "result", data: '{"a":1}' }]);
  });

  it("names an unnamed event message and joins data lines", () => {
    const parser = new SseParser();
    expect(parser.push("data: one\ndata: two\n\n")).toEqual([{ event: "message", data: "one\ntwo" }]);
  });

  it("skips comments and fields it does not keep", () => {
    const parser = new SseParser();
    expect(parser.push(": keep-alive\nid: 7\nretry: 1000\ndata: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("strips one leading space and reads a field with no colon as empty", () => {
    const parser = new SseParser();
    expect(parser.push("data:  x\ndata\n\n")).toEqual([{ event: "message", data: " x\n" }]);
  });

  it("completes an event split across pushes", () => {
    const parser = new SseParser();
    expect(parser.push("data: a")).toEqual([]);
    expect(parser.push("\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "message", data: "a" }]);
  });

  it("reads CRLF and CR line ends, and waits on a CR that may start a CRLF", () => {
    const parser = new SseParser();
    expect(parser.push("data: a\r\n\r\n")).toEqual([{ event: "message", data: "a" }]);
    expect(parser.push("data: b\r")).toEqual([]);
    expect(parser.push("\ndata: c\r\r")).toEqual([]);
    expect(parser.end()).toEqual([{ event: "message", data: "b\nc" }]);
  });

  it("drops an event with no data, and resets its name", () => {
    const parser = new SseParser();
    expect(parser.push("event: ping\n\n")).toEqual([]);
    expect(parser.push("data: z\n\n")).toEqual([{ event: "message", data: "z" }]);
  });

  it("drops an unfinished event at the end of the stream, then starts clean", () => {
    const parser = new SseParser();
    expect(parser.push("event: result\ndata: partial\n")).toEqual([]);
    expect(parser.end()).toEqual([]);
    expect(parser.push("data: next\n\n")).toEqual([{ event: "message", data: "next" }]);
  });
});
