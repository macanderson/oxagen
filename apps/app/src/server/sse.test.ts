import { describe, expect, it, vi } from "vitest";
import { notBacked } from "@/data/not-backed";
import { InvalidStreamCursor } from "./errors";
import {
  STREAM_READ_FAILED,
  abortableSleep,
  compareSeq,
  createCursorStream,
  encodeSseEvent,
  isStreamSeq,
  resolveStreamCursor,
  type StreamRead,
} from "./sse";

type Item = { seq: string; kind: string };

/** Read the whole stream as text (it must close on its own). */
async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** Parse the SSE text into events (comments and retry lines kept apart). */
function events(text: string) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const fields: Record<string, string> = {};
      for (const line of block.split("\n")) {
        const at = line.indexOf(": ");
        const key = line.slice(0, at);
        fields[key] = line.slice(at + 2);
      }
      return fields;
    });
}

function scripted(pages: Array<Awaited<ReturnType<StreamRead<Item>>>>) {
  const cursors: string[] = [];
  const read: StreamRead<Item> = (after) => {
    cursors.push(after);
    const next = pages.shift();
    return Promise.resolve(next ?? notBacked("M1", "G6"));
  };
  return { read, cursors };
}

const ok = (...seqs: string[]) => ({
  ok: true as const,
  value: seqs.map((seq) => ({ seq, kind: "tool.result" })),
});
const noSleep = () => Promise.resolve();

describe("cursor helpers", () => {
  it("accepts decimal run_seq values only", () => {
    for (const good of ["0", "1", "42", "9223372036854775807"])
      expect(isStreamSeq(good)).toBe(true);
    for (const bad of ["", "-1", "01", "1.5", "1e3", "abc", "1".repeat(21)])
      expect(isStreamSeq(bad)).toBe(false);
  });

  it("compares beyond 2^53 exactly", () => {
    expect(compareSeq("9007199254740993", "9007199254740992")).toBe(1);
    expect(compareSeq("2", "10")).toBe(-1);
    expect(compareSeq("7", "7")).toBe(0);
  });

  it("resumes from Last-Event-ID over ?after, and from 0 with neither", () => {
    expect(resolveStreamCursor("15", "3")).toBe("15");
    expect(resolveStreamCursor(null, "3")).toBe("3");
    expect(resolveStreamCursor("", "3")).toBe("3");
    expect(resolveStreamCursor(null, null)).toBe("0");
  });

  it("refuses a cursor that is not a decimal seq", () => {
    expect(() => resolveStreamCursor("abc", null)).toThrow(InvalidStreamCursor);
    expect(() => resolveStreamCursor(null, "-5")).toThrow(InvalidStreamCursor);
    expect(() => resolveStreamCursor("1 OR 1=1", "3")).toThrow(
      InvalidStreamCursor,
    );
  });

  it("encodes an event with and without an id", () => {
    expect(
      encodeSseEvent({ id: "7", event: "frame", data: { a: "x\ny" } }),
    ).toBe('id: 7\nevent: frame\ndata: {"a":"x\\ny"}\n\n');
    expect(encodeSseEvent({ event: "state", data: 1 })).toBe(
      "event: state\ndata: 1\n\n",
    );
  });
});

describe("createCursorStream", () => {
  it("sends each item with its seq as the event id, advances the cursor, then streams the terminal state", async () => {
    const { read, cursors } = scripted([ok("1", "2"), ok("3")]);
    const text = await drain(
      createCursorStream({
        read,
        cursor: "0",
        event: "frame",
        signal: new AbortController().signal,
        sleep: noSleep,
      }),
    );
    const evs = events(text);
    expect(evs[0]).toEqual({ retry: "3000" });
    expect(evs.slice(1, 4)).toEqual([
      { id: "1", event: "frame", data: '{"seq":"1","kind":"tool.result"}' },
      { id: "2", event: "frame", data: '{"seq":"2","kind":"tool.result"}' },
      { id: "3", event: "frame", data: '{"seq":"3","kind":"tool.result"}' },
    ]);
    expect(evs[4]).toEqual({
      event: "state",
      data: JSON.stringify(notBacked("M1", "G6")),
    });
    expect(cursors).toEqual(["0", "2", "3"]);
  });

  it("is idempotent: never re-sends a seq at or below the cursor (at-least-once reads)", async () => {
    const { read } = scripted([ok("4", "5"), ok("5", "4", "6"), ok("6")]);
    const text = await drain(
      createCursorStream({
        read,
        cursor: "3",
        event: "frame",
        signal: new AbortController().signal,
        sleep: noSleep,
      }),
    );
    const ids = events(text)
      .map((e) => e.id)
      .filter(Boolean);
    expect(ids).toEqual(["4", "5", "6"]);
  });

  it("skips an item whose seq is not a decimal", async () => {
    const { read } = scripted([ok("x", "2")]);
    const ids = events(
      await drain(
        createCursorStream({
          read,
          cursor: "0",
          event: "frame",
          signal: new AbortController().signal,
          sleep: noSleep,
        }),
      ),
    )
      .map((e) => e.id)
      .filter(Boolean);
    expect(ids).toEqual(["2"]);
  });

  it("streams a denied read as a state event and closes", async () => {
    const { read } = scripted([
      { ok: false, reason: "denied", permission: "view_run" },
    ]);
    const evs = events(
      await drain(
        createCursorStream({
          read,
          cursor: "0",
          event: "frame",
          signal: new AbortController().signal,
        }),
      ),
    );
    expect(evs.at(-1)).toEqual({
      event: "state",
      data: '{"ok":false,"reason":"denied","permission":"view_run"}',
    });
  });

  it("reports a thrown read, sends the read-failed state, and closes", async () => {
    const boom = new Error("pool exhausted");
    const onError = vi.fn(() => Promise.reject(new Error("reporter down")));
    const evs = events(
      await drain(
        createCursorStream<Item>({
          read: () => Promise.reject(boom),
          cursor: "0",
          event: "frame",
          signal: new AbortController().signal,
          onError,
        }),
      ),
    );
    expect(evs.at(-1)).toEqual({
      event: "state",
      data: JSON.stringify(STREAM_READ_FAILED),
    });
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(boom);
    });
  });

  it("polls while idle, sends a keep-alive comment on the interval, and closes at the max duration", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const read: StreamRead<Item> = () => Promise.resolve(ok());
    const text = await drain(
      createCursorStream({
        read,
        cursor: "0",
        event: "patch",
        signal: new AbortController().signal,
        pollMs: 1000,
        keepAliveMs: 2000,
        maxDurationMs: 5000,
        now: () => clock,
        sleep: (ms) => {
          sleeps.push(ms);
          clock += ms;
          return Promise.resolve();
        },
      }),
    );
    expect(sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
    expect(text.match(/: keep-alive/g)?.length).toBe(2);
    expect(text).not.toContain("event:");
  });

  it("closes when the request is aborted", async () => {
    const controller = new AbortController();
    const read: StreamRead<Item> = () => Promise.resolve(ok());
    const stream = createCursorStream({
      read,
      cursor: "0",
      event: "frame",
      signal: controller.signal,
      pollMs: 10_000,
    });
    const done = drain(stream);
    setTimeout(() => {
      controller.abort();
    }, 5);
    await expect(done).resolves.toBe("retry: 3000\n\n");
  });

  it("stops reading once the consumer cancels", async () => {
    const read = vi.fn<StreamRead<Item>>(() => Promise.resolve(ok()));
    const stream = createCursorStream({
      read,
      cursor: "0",
      event: "frame",
      signal: new AbortController().signal,
      sleep: noSleep,
    });
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    const calls = read.mock.calls.length;
    await new Promise((r) => setTimeout(r, 5));
    expect(read.mock.calls.length).toBeLessThanOrEqual(calls + 1);
  });
});

describe("abortableSleep", () => {
  it("resolves after the delay, early on abort, and at once when already aborted", async () => {
    vi.useFakeTimers();
    try {
      const c = new AbortController();
      let slept = false;
      const p = abortableSleep(1000, c.signal).then(() => {
        slept = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(slept).toBe(false);
      c.abort();
      await p;
      expect(slept).toBe(true);
      await abortableSleep(1000, c.signal);
      const d = abortableSleep(50, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(50);
      await d;
    } finally {
      vi.useRealTimers();
    }
  });
});
