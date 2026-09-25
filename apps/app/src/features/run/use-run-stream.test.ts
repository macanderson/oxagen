// @vitest-environment jsdom
// Following a live run's frames, against a fake EventSource.
//
// The hook's job is to say "there is more to read" and nothing else, so what
// these prove is the signalling: one callback per window however many frames
// land, a reconnect at the cursor the route hands back when it closes an idle
// stream, a stop when the route says the run sealed, and a `lost` state only
// when the connection is closed for good rather than between retries.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRunStream } from "./use-run-stream";

const URL_UNDER_TEST = "/api/v1/acme/core-platform/runs/tse_7k2m9q/stream";

/** Every source a render opened, in order, so a test can drive the newest. */
let opened: FakeEventSource[] = [];

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, (event: MessageEvent) => void>();

  constructor(
    readonly url: string,
    readonly init?: { withCredentials?: boolean },
  ) {
    opened.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    this.listeners.set(type, handler);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  /** The route opened and the first frames are on their way. */
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  /** One frame arrived. */
  frame() {
    this.onmessage?.();
  }

  /** The route closed the stream with its terminator. */
  done(payload: unknown) {
    this.listeners.get("done")?.(
      new MessageEvent("done", { data: JSON.stringify(payload) }),
    );
  }

  /** The route closed the stream with a body that is not the terminator's shape. */
  doneRaw(data: string) {
    this.listeners.get("done")?.(new MessageEvent("done", { data }));
  }

  serverError(payload: unknown) {
    this.serverErrorRaw(JSON.stringify(payload));
  }

  serverErrorRaw(data: string) {
    this.listeners.get("error")?.(new MessageEvent("error", { data }));
    this.onerror?.();
  }

  /** The connection dropped. `forGood` is the case the person should be told about. */
  fail(forGood: boolean) {
    this.readyState = forGood
      ? FakeEventSource.CLOSED
      : FakeEventSource.CONNECTING;
    this.onerror?.();
  }
}

/** The one source this render opened, or a refusal: a silent undefined would read as a pass. */
function latest(): FakeEventSource {
  const source = opened.at(-1);
  if (source === undefined) throw new Error("no stream was opened");
  return source;
}

beforeEach(() => {
  opened = [];
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function follow(onFrames = vi.fn(), enabled = true) {
  const view = renderHook(() =>
    useRunStream({ url: URL_UNDER_TEST, enabled, onFrames }),
  );
  return { ...view, onFrames };
}

describe("useRunStream", () => {
  it("opens the stream with credentials, because the session cookie is what authorizes the read", () => {
    follow();
    expect(latest().url).toBe(URL_UNDER_TEST);
    expect(latest().init?.withCredentials).toBe(true);
  });

  it("reports connecting until the route answers, then open", () => {
    const { result } = follow();
    expect(result.current).toBe("connecting");
    act(() => {
      latest().open();
    });
    expect(result.current).toBe("open");
  });

  it("opens nothing at all on a run it was not asked to follow (negative)", () => {
    const { result } = follow(vi.fn(), false);
    expect(opened).toHaveLength(0);
    expect(result.current).toBe("off");
  });

  it("reports off, and opens nothing, where the browser has no EventSource (negative)", () => {
    vi.stubGlobal("EventSource", undefined);
    const { result } = follow();
    expect(opened).toHaveLength(0);
    expect(result.current).toBe("off");
  });

  it("calls back once for a burst of frames, not once per frame", () => {
    const { onFrames } = follow();
    act(() => {
      latest().open();
      latest().frame();
      latest().frame();
      latest().frame();
    });
    expect(onFrames).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(onFrames).toHaveBeenCalledTimes(1);
  });

  it("calls back again for the next burst, so a long run keeps being read", () => {
    const { onFrames } = follow();
    act(() => {
      latest().open();
      latest().frame();
      vi.advanceTimersByTime(750);
      latest().frame();
      vi.advanceTimersByTime(750);
    });
    expect(onFrames).toHaveBeenCalledTimes(2);
  });

  it("reads the tail once more and stops when the route says the run sealed", () => {
    const { result, onFrames } = follow();
    act(() => {
      latest().open();
      latest().done({ reason: "sealed", cursor: "ZjoxMQ" });
    });
    expect(onFrames).toHaveBeenCalledTimes(1);
    expect(result.current).toBe("sealed");
    expect(opened).toHaveLength(1);
  });

  it("reopens at the cursor when the route closes an idle stream", () => {
    follow();
    act(() => {
      latest().open();
      latest().done({ reason: "idle", cursor: "ZjoxMQ" });
    });
    expect(opened).toHaveLength(2);
    expect(latest().url).toBe(`${URL_UNDER_TEST}?after=ZjoxMQ`);
    expect(opened[0]?.closed).toBe(true);
  });

  it("reopens from the start when an idle close carried no cursor", () => {
    follow();
    act(() => {
      latest().open();
      latest().done({ reason: "idle", cursor: null });
    });
    expect(latest().url).toBe(URL_UNDER_TEST);
  });

  it("treats a terminator it cannot read as an idle close, never as a seal (negative)", () => {
    const { result } = follow();
    act(() => {
      latest().open();
      latest().doneRaw("not json");
    });
    expect(result.current).not.toBe("sealed");
    expect(opened).toHaveLength(2);
  });

  it("says nothing while EventSource is retrying: a reconnect is not a loss (negative)", () => {
    const { result } = follow();
    act(() => {
      latest().open();
      latest().fail(false);
    });
    expect(result.current).toBe("open");
  });

  it("says the connection was lost once it is closed for good", () => {
    const { result } = follow();
    act(() => {
      latest().open();
      latest().fail(true);
    });
    expect(result.current).toBe("lost");
  });

  it.each(["invalid_input", "run_not_found"])(
    "stops retrying after a typed server error %s",
    (code) => {
      const { result, onFrames } = follow();
      act(() => {
        latest().open();
        latest().serverError({ code });
      });
      expect(result.current).toBe("lost");
      expect(latest().closed).toBe(true);
      expect(opened).toHaveLength(1);
      expect(onFrames).toHaveBeenCalledTimes(code === "invalid_input" ? 1 : 0);
    },
  );

  it.each(["authz_denied", "forbidden", "surface_denied"])(
    "retains the server refusal %s through the native error callback",
    (code) => {
      const { result, onFrames } = follow();
      act(() => {
        latest().open();
        latest().frame();
        latest().serverError({ code });
      });
      expect(result.current).toBe("denied");
      expect(latest().closed).toBe(true);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(onFrames).toHaveBeenCalledOnce();
    },
  );

  it.each(["stream_unavailable", "invalid_input", "unknown"])(
    "flushes delivered frames once when %s closes the source",
    (code) => {
      const { onFrames } = follow();
      act(() => {
        latest().open();
        latest().frame();
        latest().serverError({ code });
      });
      expect(onFrames).toHaveBeenCalledOnce();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(onFrames).toHaveBeenCalledOnce();
    },
  );

  it("reopens at the route's cursor after stream_unavailable, and reaches open again (#3652)", () => {
    const { result } = follow();
    act(() => {
      latest().open();
      latest().frame();
      latest().serverError({ code: "stream_unavailable", cursor: "ZjoxMQ" });
    });
    // Closed, and waiting out the first backoff rather than reporting a loss.
    expect(opened[0]?.closed).toBe(true);
    expect(opened).toHaveLength(1);
    expect(result.current).toBe("connecting");
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(opened).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // The cursor is the last frame the route wrote, so nothing is read twice
    // and nothing is skipped.
    expect(opened).toHaveLength(2);
    expect(latest().url).toBe(`${URL_UNDER_TEST}?after=ZjoxMQ`);
    act(() => {
      latest().open();
    });
    expect(result.current).toBe("open");
  });

  it("retries from where the failed source started when the route had no cursor to give", () => {
    follow();
    act(() => {
      latest().open();
      latest().done({ reason: "idle", cursor: "ZjoxMQ" });
    });
    act(() => {
      latest().open();
      latest().serverError({ code: "stream_unavailable", cursor: null });
      vi.advanceTimersByTime(1000);
    });
    expect(latest().url).toBe(`${URL_UNDER_TEST}?after=ZjoxMQ`);
  });

  it("backs off twice as long each time and reports lost at the retry ceiling (negative)", () => {
    const { result } = follow();
    act(() => {
      latest().open();
    });
    for (const wait of [1000, 2000, 4000, 8000, 16_000]) {
      const before = opened.length;
      act(() => {
        latest().serverError({ code: "stream_unavailable", cursor: null });
      });
      expect(result.current).toBe("connecting");
      act(() => {
        vi.advanceTimersByTime(wait - 1);
      });
      expect(opened).toHaveLength(before);
      act(() => {
        vi.advanceTimersByTime(1);
        latest().open();
      });
      expect(opened).toHaveLength(before + 1);
    }
    act(() => {
      latest().serverError({ code: "stream_unavailable", cursor: null });
    });
    expect(result.current).toBe("lost");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // Five retries, then nothing more is opened.
    expect(opened).toHaveLength(6);
  });

  it("keeps backing off when a reopen fails before the route answers (#3652)", () => {
    const { result } = follow();
    act(() => {
      latest().open();
      latest().serverError({ code: "stream_unavailable", cursor: "ZjoxMQ" });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(opened).toHaveLength(2);
    // The fault has not cleared, so the route's first read fails and it
    // answers with a status. EventSource closes without ever opening.
    act(() => {
      latest().fail(true);
    });
    expect(result.current).toBe("connecting");
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(opened).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(opened).toHaveLength(3);
    expect(latest().url).toBe(`${URL_UNDER_TEST}?after=ZjoxMQ`);
    act(() => {
      latest().open();
    });
    expect(result.current).toBe("open");
  });

  it("reports lost after five retries when every reopen fails before the route answers (negative)", () => {
    const { result } = follow();
    act(() => {
      latest().open();
      latest().serverError({ code: "stream_unavailable", cursor: null });
    });
    for (const wait of [1000, 2000, 4000, 8000]) {
      act(() => {
        vi.advanceTimersByTime(wait);
        latest().fail(true);
      });
      expect(result.current).toBe("connecting");
    }
    act(() => {
      vi.advanceTimersByTime(16_000);
      latest().fail(true);
    });
    expect(result.current).toBe("lost");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(opened).toHaveLength(6);
  });

  it("reports lost when a reopened source that answered is closed for good (negative)", () => {
    const { result } = follow();
    act(() => {
      latest().open();
      latest().serverError({ code: "stream_unavailable", cursor: null });
      vi.advanceTimersByTime(1000);
      latest().open();
      latest().fail(true);
    });
    expect(result.current).toBe("lost");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(opened).toHaveLength(2);
  });

  it("starts the backoff over once a frame arrives between failures", () => {
    follow();
    act(() => {
      latest().open();
      latest().serverError({ code: "stream_unavailable", cursor: null });
      vi.advanceTimersByTime(1000);
      latest().open();
      latest().serverError({ code: "stream_unavailable", cursor: null });
      vi.advanceTimersByTime(2000);
      latest().open();
      latest().frame();
      latest().serverError({ code: "stream_unavailable", cursor: "ZjoxMw" });
    });
    expect(opened).toHaveLength(3);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // Progress reset the count, so the wait is the first one again.
    expect(opened).toHaveLength(4);
    expect(latest().url).toBe(`${URL_UNDER_TEST}?after=ZjoxMw`);
  });

  it("opens nothing more when the view goes away during a backoff (negative)", () => {
    const { unmount } = follow();
    act(() => {
      latest().open();
      latest().serverError({ code: "stream_unavailable", cursor: null });
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(opened).toHaveLength(1);
  });

  it("stops on a malformed server error without claiming the run sealed", () => {
    const { result } = follow();
    act(() => {
      latest().open();
      latest().serverErrorRaw("not json");
    });
    expect(result.current).toBe("lost");
    expect(latest().closed).toBe(true);
    expect(opened).toHaveLength(1);
  });

  it("closes the stream and drops a pending callback when the view goes away", () => {
    const { unmount, onFrames } = follow();
    act(() => {
      latest().open();
      latest().frame();
    });
    unmount();
    expect(latest().closed).toBe(true);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onFrames).not.toHaveBeenCalled();
  });
});
