// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notBacked } from "@/data/not-backed";
import type { FleetPatch } from "./stream-merge";
import {
  FLUSH_MS,
  STREAM_PAYLOAD_INVALID,
  isReadFailure,
  streamUrl,
  useEventStream,
} from "./use-event-stream";
import { useFleetLive } from "./use-fleet-live";
import { useFrames } from "./use-frames";

/** A controllable EventSource: tests push server events into it. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(e: { data: unknown }) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  error(readyState: number) {
    this.readyState = readyState;
    this.onerror?.();
  }

  emit(type: string, data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const fn of this.listeners.get(type) ?? []) fn({ data: payload });
  }

  static latest(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("no EventSource opened");
    return last;
  }
}

type Frame = { seq: string; kind: string };
function parseFrame(data: unknown): Frame {
  if (
    typeof data === "object" &&
    data !== null &&
    "seq" in data &&
    "kind" in data &&
    typeof data.seq === "string" &&
    typeof data.kind === "string"
  )
    return { seq: data.seq, kind: data.kind };
  throw new Error("not a frame");
}
const frame = (seq: string): Frame => ({ seq, kind: "tool.result" });

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => {
  act(() => {
    vi.advanceTimersByTime(FLUSH_MS);
  });
};

describe("streamUrl", () => {
  it("encodes the scope and carries run and cursor", () => {
    expect(
      streamUrl("acme", "core platform", { run: "arun_1", after: "7" }),
    ).toBe("/api/mc/acme/core%20platform/stream?run=arun_1&after=7");
    expect(streamUrl("acme", "core-platform", { after: "0" })).toBe(
      "/api/mc/acme/core-platform/stream?after=0",
    );
  });
});

describe("isReadFailure", () => {
  it("accepts each failure arm and rejects anything else", () => {
    expect(isReadFailure(notBacked("M1", "G6"))).toBe(true);
    expect(
      isReadFailure({ ok: false, reason: "denied", permission: "x" }),
    ).toBe(true);
    expect(
      isReadFailure({ ok: false, reason: "error", code: "c", status: 503 }),
    ).toBe(true);
    for (const bad of [
      null,
      "x",
      { ok: true, value: 1 },
      { ok: false, reason: "not_backed", milestone: "M1", gap: "nope" },
      { ok: false, reason: "denied" },
      { ok: false, reason: "error", code: "c" },
      { ok: false, reason: "mystery" },
    ])
      expect(isReadFailure(bad)).toBe(false);
  });
});

describe("useFrames", () => {
  const render = (initial: Frame[] = [frame("1"), frame("2")]) =>
    renderHook(() =>
      useFrames({
        org: "acme",
        ws: "core-platform",
        runId: "arun_1",
        initial,
        parse: parseFrame,
      }),
    );

  it("renders the server frames and resumes the stream after the highest seq", () => {
    const { result } = render();
    expect(result.current.frames.map((x) => x.seq)).toEqual(["1", "2"]);
    expect(FakeEventSource.latest().url).toBe(
      "/api/mc/acme/core-platform/stream?run=arun_1&after=2",
    );
    expect(result.current.state).toEqual({
      status: "connecting",
      failure: null,
    });
    act(() => {
      FakeEventSource.latest().open();
    });
    expect(result.current.state.status).toBe("open");
  });

  it("appends live frames in one batched render", () => {
    const { result } = render();
    const es = FakeEventSource.latest();
    act(() => {
      es.emit("frame", frame("3"));
      es.emit("frame", frame("4"));
    });
    expect(result.current.frames).toHaveLength(2);
    flush();
    expect(result.current.frames.map((x) => x.seq)).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("is idempotent: a replayed frame, or one the server already rendered, appears once", () => {
    const { result } = render();
    const es = FakeEventSource.latest();
    act(() => {
      es.emit("frame", frame("2"));
      es.emit("frame", frame("3"));
      es.emit("frame", frame("3"));
    });
    flush();
    act(() => {
      es.emit("frame", frame("3"));
    });
    flush();
    expect(result.current.frames.map((x) => x.seq)).toEqual(["1", "2", "3"]);
  });

  it("closes and surfaces the failure when the server streams a failed read", () => {
    const { result } = render();
    const es = FakeEventSource.latest();
    act(() => {
      es.emit("frame", frame("3"));
      es.emit("state", notBacked("M1", "G6"));
    });
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
    expect(result.current.state).toEqual({
      status: "closed",
      failure: notBacked("M1", "G6"),
    });
    // The frame buffered before the state still lands.
    expect(result.current.frames.map((x) => x.seq)).toEqual(["1", "2", "3"]);
    act(() => {
      es.emit("frame", frame("4"));
      es.error(FakeEventSource.CLOSED);
    });
    flush();
    expect(result.current.frames).toHaveLength(3);
    expect(result.current.state.status).toBe("closed");
  });

  it("rejects a frame its schema rejects: never appended, stream closed as invalid", () => {
    const { result } = render();
    const es = FakeEventSource.latest();
    act(() => {
      es.emit("frame", { seq: "3" });
    });
    flush();
    expect(result.current.frames).toHaveLength(2);
    expect(result.current.state).toEqual({
      status: "closed",
      failure: STREAM_PAYLOAD_INVALID,
    });
  });

  it("treats a malformed payload or state as invalid", () => {
    const { result } = render();
    act(() => {
      FakeEventSource.latest().emit("frame", "{not json");
    });
    expect(result.current.state.failure).toEqual(STREAM_PAYLOAD_INVALID);

    const second = render();
    act(() => {
      FakeEventSource.latest().emit("state", { ok: false, reason: "??" });
    });
    expect(second.result.current.state.failure).toEqual(STREAM_PAYLOAD_INVALID);
  });

  it("reports reconnecting while EventSource retries, and open again after", () => {
    const { result } = render();
    const es = FakeEventSource.latest();
    act(() => {
      es.open();
      es.error(FakeEventSource.CONNECTING);
    });
    expect(result.current.state.status).toBe("connecting");
    act(() => {
      es.open();
    });
    expect(result.current.state.status).toBe("open");
    act(() => {
      es.error(FakeEventSource.CLOSED);
    });
    expect(result.current.state.status).toBe("closed");
  });

  it("closes the stream on unmount and drops a pending batch", () => {
    const { result, unmount } = render();
    const es = FakeEventSource.latest();
    act(() => {
      es.emit("frame", frame("3"));
    });
    unmount();
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(result.current.frames).toHaveLength(2);
  });

  it("opens no stream when live is false", () => {
    const { result } = renderHook(() =>
      useFrames({
        org: "acme",
        ws: "core-platform",
        runId: "arun_1",
        initial: [frame("1")],
        parse: parseFrame,
        live: false,
      }),
    );
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(result.current.state).toEqual({ status: "closed", failure: null });
  });
});

type Row = { id: string; status: string };
function parsePatch(data: unknown): FleetPatch<Row> {
  if (typeof data !== "object" || data === null) throw new Error("bad");
  const d = data as Record<string, unknown>;
  if (typeof d.seq !== "string") throw new Error("bad");
  if (d.op === "remove" && typeof d.id === "string")
    return { seq: d.seq, op: "remove", id: d.id };
  const row = d.row as Record<string, unknown> | undefined;
  if (
    d.op === "upsert" &&
    typeof row?.id === "string" &&
    typeof row.status === "string"
  )
    return {
      seq: d.seq,
      op: "upsert",
      row: { id: row.id, status: row.status },
    };
  throw new Error("bad");
}

describe("useFleetLive", () => {
  const initial: Row[] = [
    { id: "arun_a", status: "live" },
    { id: "arun_b", status: "live" },
  ];
  const render = () =>
    renderHook(() =>
      useFleetLive({
        org: "acme",
        ws: "core-platform",
        initial,
        after: "40",
        parse: parsePatch,
      }),
    );

  it("streams fleet patches after the rendered cursor", () => {
    const { result } = render();
    expect(FakeEventSource.latest().url).toBe(
      "/api/mc/acme/core-platform/stream?after=40",
    );
    expect(result.current.rows).toBe(initial);
  });

  it("applies upserts and removals, and ignores replays", () => {
    const { result } = render();
    const es = FakeEventSource.latest();
    act(() => {
      es.emit("patch", {
        seq: "41",
        op: "upsert",
        row: { id: "arun_a", status: "paused" },
      });
      es.emit("patch", {
        seq: "42",
        op: "upsert",
        row: { id: "arun_c", status: "live" },
      });
      es.emit("patch", { seq: "43", op: "remove", id: "arun_b" });
      // Replays after a reconnect: must change nothing.
      es.emit("patch", {
        seq: "41",
        op: "upsert",
        row: { id: "arun_a", status: "live" },
      });
      es.emit("patch", { seq: "42", op: "remove", id: "arun_c" });
    });
    flush();
    expect(result.current.rows).toEqual([
      { id: "arun_c", status: "live" },
      { id: "arun_a", status: "paused" },
    ]);
  });

  it("lets fresher server rows win when the page re-renders at a newer cursor", () => {
    const { result, rerender } = renderHook(
      (props: { initial: Row[]; after: string }) =>
        useFleetLive({
          org: "acme",
          ws: "core-platform",
          initial: props.initial,
          after: props.after,
          parse: parsePatch,
        }),
      { initialProps: { initial, after: "40" } },
    );
    const first = FakeEventSource.latest();
    act(() => {
      first.emit("patch", {
        seq: "41",
        op: "upsert",
        row: { id: "arun_a", status: "running" },
      });
      first.emit("patch", { seq: "42", op: "remove", id: "arun_b" });
    });
    flush();
    expect(result.current.rows).toEqual([{ id: "arun_a", status: "running" }]);

    // updateTag / router.refresh: new props, same component instance.
    const fresh: Row[] = [
      { id: "arun_a", status: "done" },
      { id: "arun_b", status: "live" },
    ];
    rerender({ initial: fresh, after: "50" });
    expect(result.current.rows).toBe(fresh);
    const resumed = FakeEventSource.latest();
    expect(resumed.url).toBe("/api/mc/acme/core-platform/stream?after=50");

    // A replay at or below the new cursor changes nothing; a newer patch lands.
    act(() => {
      resumed.emit("patch", {
        seq: "41",
        op: "upsert",
        row: { id: "arun_a", status: "running" },
      });
      resumed.emit("patch", {
        seq: "51",
        op: "upsert",
        row: { id: "arun_b", status: "paused" },
      });
    });
    flush();
    expect(result.current.rows).toEqual([
      { id: "arun_a", status: "done" },
      { id: "arun_b", status: "paused" },
    ]);
  });

  it("closes on a patch that fails its schema", () => {
    const { result } = render();
    act(() => {
      FakeEventSource.latest().emit("patch", { seq: "41", op: "explode" });
    });
    expect(result.current.state.failure).toEqual(STREAM_PAYLOAD_INVALID);
    expect(result.current.rows).toBe(initial);
  });
});

describe("useEventStream", () => {
  it("stays closed without a URL", () => {
    const { result } = renderHook(() =>
      useEventStream({
        url: null,
        event: "frame",
        parse: parseFrame,
        onItems: () => undefined,
      }),
    );
    expect(result.current.status).toBe("closed");
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
