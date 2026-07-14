/**
 * Unit tests for the REPL launch splash (startup-splash.ts). The splash's
 * whole contract is byte-level: what it writes to the stream, when, and that
 * it writes NOTHING off a TTY. Tests drive it with vitest fake timers plus an
 * injected `now` clock derived from the same fake time, and assert against
 * the captured write stream directly. Signal behavior is exercised through an
 * injected EventEmitter + raise spy — never the real `process`, whose SIGINT
 * listeners belong to the test runner.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startStartupSplash } from "../startup-splash.js";

interface FakeStream {
  isTTY: boolean;
  writes: string[];
  failWrites: boolean;
  write(chunk: string): boolean;
}

function fakeStream(isTTY = true): FakeStream {
  const s: FakeStream = {
    isTTY,
    writes: [],
    failWrites: false,
    write(chunk: string) {
      if (s.failWrites) throw new Error("EIO: stream is gone");
      s.writes.push(chunk);
      return true;
    },
  };
  return s;
}

function splashOn(
  stream: FakeStream,
  extra: { signals?: EventEmitter; raise?: (s: string) => void } = {},
) {
  return startStartupSplash({
    stream: stream as unknown as NodeJS.WriteStream,
    now: () => Date.now(), // fake-timer time — advances with vi.advanceTimersByTime
    signals: (extra.signals ??
      new EventEmitter()) as unknown as import("../startup-splash.js").SplashSignalSource,
    raise: extra.raise as never,
  });
}

describe("startStartupSplash", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("writes a first frame synchronously — feedback even if the loop starves", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    const first = stream.writes[0] ?? "";
    expect(first.startsWith("\r\x1b[2K")).toBe(true); // frame rewrites in place
    expect(first).toContain("oxagen");
    expect(first).toContain("waking the context engine…");
    splash.stop();
  });

  it("never hides the cursor — no handler can guarantee restoring it (blocked-loop SIGINT)", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    vi.advanceTimersByTime(1000);
    splash.stop();
    expect(stream.writes.join("")).not.toContain("\x1b[?25l");
  });

  it("advances the spinner glyph frame over frame", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    expect(stream.writes.at(-1)).toContain("⠋");
    vi.advanceTimersByTime(80);
    const second = stream.writes.at(-1) ?? "";
    expect(second).toContain("⠙");
    expect(second).not.toContain("⠋");
    vi.advanceTimersByTime(80);
    expect(stream.writes.at(-1)).toContain("⠹");
    splash.stop();
  });

  it("rotates the status message on the 1.5s cadence", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    vi.advanceTimersByTime(1600);
    const out = stream.writes.join("");
    expect(out).toContain("loading the agent engine…");
    splash.stop();
  });

  it("settles on the last message and appends elapsed seconds on long launches", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    vi.advanceTimersByTime(12_000);
    const last = stream.writes.at(-1) ?? "";
    expect(last).toContain("almost there…");
    expect(last).toMatch(/\(\d+s\)/);
    splash.stop();
  });

  it("shows the elapsed suffix exactly from the 5s boundary, not before", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    vi.advanceTimersByTime(4880); // last full frame strictly before 5000ms
    expect(stream.writes.at(-1)).not.toMatch(/\(\d+s\)/);
    vi.advanceTimersByTime(200); // first frame at/after 5000ms
    expect(stream.writes.at(-1)).toMatch(/\(5s\)/);
    splash.stop();
  });

  it("stop() clears the line and halts the timer", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    splash.stop();
    const afterStop = stream.writes.length;
    expect(stream.writes.at(-1)).toBe("\r\x1b[2K");
    vi.advanceTimersByTime(2000);
    expect(stream.writes.length).toBe(afterStop); // no frames after stop
  });

  it("stop() is idempotent — a double stop writes nothing extra", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    splash.stop();
    const afterStop = stream.writes.length;
    splash.stop();
    expect(stream.writes.length).toBe(afterStop);
  });

  it("SIGINT clears the splash line, then re-raises; SIGTERM likewise", () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const stream = fakeStream();
      const signals = new EventEmitter();
      const raise = vi.fn();
      splashOn(stream, { signals, raise });
      signals.emit(signal);
      // Line cleared BEFORE the re-raise fires.
      expect(stream.writes.at(-1)).toBe("\r\x1b[2K");
      expect(raise).toHaveBeenCalledTimes(1);
      expect(raise).toHaveBeenCalledWith(signal);
      // Both handlers are gone — stop() deregistered the sibling too.
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    }
  });

  it("stop() deregisters both signal handlers without raising", () => {
    const stream = fakeStream();
    const signals = new EventEmitter();
    const raise = vi.fn();
    const splash = splashOn(stream, { signals, raise });
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    splash.stop();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(raise).not.toHaveBeenCalled();
  });

  it("self-stops when the stream dies mid-animation instead of throwing", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    const painted = stream.writes.length;
    stream.failWrites = true;
    expect(() => vi.advanceTimersByTime(160)).not.toThrow();
    stream.failWrites = false;
    vi.advanceTimersByTime(2000);
    expect(stream.writes.length).toBe(painted); // timer halted, no late frames
    splash.stop(); // idempotent: already stopped by the failure path
    expect(stream.writes.length).toBe(painted);
  });

  it("is inert off a TTY: zero bytes written, stop() safe", () => {
    const stream = fakeStream(false);
    const signals = new EventEmitter();
    const splash = splashOn(stream, { signals });
    vi.advanceTimersByTime(2000);
    splash.stop();
    expect(stream.writes).toEqual([]);
    expect(signals.listenerCount("SIGINT")).toBe(0); // inert ⇒ no signal wiring
  });

  it("honors non-empty NO_COLOR: frames carry no color escapes but still animate", () => {
    vi.stubEnv("NO_COLOR", "1");
    const stream = fakeStream();
    const splash = splashOn(stream);
    vi.advanceTimersByTime(200);
    const frames = stream.writes.filter((w) => w.includes("oxagen"));
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f).not.toContain("[38;2;"); // no truecolor
      expect(f).not.toContain("\x1b[1m"); // no bold
      expect(f).not.toContain("\x1b[2m"); // no dim
    }
    splash.stop();
  });

  it("treats an EMPTY NO_COLOR as color-enabled, matching no-color.org and chalk", () => {
    vi.stubEnv("NO_COLOR", "");
    const stream = fakeStream();
    const splash = splashOn(stream);
    expect(stream.writes.join("")).toContain("[38;2;");
    splash.stop();
  });
});
