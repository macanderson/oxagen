/**
 * The decoder is written to the event-stream grammar, not to today's server
 * output, so each case here is a shape the grammar allows and the server may
 * not emit: CRLF, bare CR, several `data:` lines, comment lines, and a final
 * record with no trailing blank line. The last case is the one that matters
 * most in practice — a stream closed mid-record is what a dropped connection
 * looks like.
 */
import { describe, expect, it } from "vitest";
import { SseDecoder, decodeSseStream, frameSeq, recordToFrame } from "./sse";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("SseDecoder", () => {
  it("returns a record once its blank line arrives, and nothing before", () => {
    const d = new SseDecoder();
    expect(d.push('id: 1\ndata: {"a":1}\n')).toEqual([]);
    expect(d.push("\n")).toEqual([{ id: "1", data: '{"a":1}' }]);
  });

  it("splits records that arrive in one chunk and across chunk boundaries", () => {
    const d = new SseDecoder();
    const first = d.push("data: one\n\ndata: tw");
    expect(first).toEqual([{ data: "one" }]);
    expect(d.push("o\n\n")).toEqual([{ data: "two" }]);
  });

  it("accepts CRLF and bare CR line ends", () => {
    const d = new SseDecoder();
    expect(d.push("id: 7\r\ndata: x\r\n\r\n")).toEqual([
      { id: "7", data: "x" },
    ]);
    // A trailing CR waits for the next chunk (an LF may follow it); the
    // record closes once the next line begins.
    expect(d.push("data: y\r\rdata: z")).toEqual([{ data: "y" }]);
  });

  it("holds a trailing CR until the next chunk says whether an LF follows", () => {
    const d = new SseDecoder();
    expect(d.push("data: a\r")).toEqual([]);
    expect(d.push("\n\r\n")).toEqual([{ data: "a" }]);
  });

  it("joins several data lines with a newline and strips one leading space", () => {
    const d = new SseDecoder();
    expect(d.push('data: {\ndata:  "k": 1\ndata: }\n\n')).toEqual([
      { data: '{\n "k": 1\n}' },
    ]);
  });

  it("ignores comment lines and unknown fields, and keeps event:", () => {
    const d = new SseDecoder();
    expect(d.push(": keepalive\nretry: 5\nevent: frame\ndata: z\n\n")).toEqual([
      { event: "frame", data: "z" },
    ]);
  });

  it("drops a record with no data line", () => {
    const d = new SseDecoder();
    expect(d.push("id: 3\n\n")).toEqual([]);
    expect(d.push("data: after\n\n")).toEqual([{ data: "after" }]);
  });

  it("flushes a final record that no blank line closed", () => {
    const d = new SseDecoder();
    expect(d.push("id: 9\ndata: tail")).toEqual([]);
    expect(d.flush()).toEqual({ id: "9", data: "tail" });
    expect(d.flush()).toBeUndefined();
  });
});

describe("decodeSseStream", () => {
  it("yields every record across chunk boundaries and the unterminated tail", async () => {
    const records = await collect(
      decodeSseStream(
        stream(['id: 1\ndata: {"s":1}\n\nid: 2\nda', 'ta: {"s":2}']),
      ),
    );
    expect(records).toEqual([
      { id: "1", data: '{"s":1}' },
      { id: "2", data: '{"s":2}' },
    ]);
  });

  it("cancels the body when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: a\n\ndata: b\n\n"));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const record of decodeSseStream(body)) {
      expect(record.data).toBe("a");
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe("recordToFrame", () => {
  it("reads seq from the JSON and leaves the id line alone when both agree", () => {
    const frame = recordToFrame({
      id: "4",
      data: '{"seq":4,"type":"turn_released"}',
    });
    expect(frame).toEqual({ seq: 4, type: "turn_released" });
    expect(frameSeq(frame)).toBe(4);
  });

  it("falls back to the id line when the JSON carries no seq", () => {
    const frame = recordToFrame({ id: "12", data: '{"type":"turn_released"}' });
    expect(frameSeq(frame)).toBe(12);
  });

  it("leaves replay_truncated without a seq even when an id line is present", () => {
    const frame = recordToFrame({
      id: "0",
      data: '{"type":"replay_truncated","requested_after":5,"oldest_retained":9}',
    });
    expect(frameSeq(frame)).toBeUndefined();
  });

  it("names the record in the error when it is not JSON", () => {
    expect(() => recordToFrame({ data: "not json" })).toThrow(
      /not JSON: not json/,
    );
  });

  it("refuses a record with no type", () => {
    expect(() => recordToFrame({ data: '{"seq":1}' })).toThrow(/no "type"/);
  });
});
