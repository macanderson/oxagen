/**
 * Unit tests for the REPL launch splash (startup-splash.ts). The splash's
 * whole contract is byte-level: what it writes to the stream, when, and that
 * it writes NOTHING off a TTY. Tests drive it with vitest fake timers plus an
 * injected `now` clock derived from the same fake time, and assert against
 * the captured write stream directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startStartupSplash } from "../startup-splash.js";

interface FakeStream {
  isTTY: boolean;
  writes: string[];
  write(chunk: string): boolean;
}

function fakeStream(isTTY = true): FakeStream {
  const s: FakeStream = {
    isTTY,
    writes: [],
    write(chunk: string) {
      s.writes.push(chunk);
      return true;
    },
  };
  return s;
}

function splashOn(stream: FakeStream) {
  return startStartupSplash({
    stream: stream as unknown as NodeJS.WriteStream,
    now: () => Date.now(), // fake-timer time — advances with vi.advanceTimersByTime
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
    const out = stream.writes.join("");
    expect(out).toContain("\x1b[?25l"); // cursor hidden
    expect(out).toContain("oxagen");
    expect(out).toContain("waking the context engine…");
    splash.stop();
  });

  it("animates: later frames advance the spinner and rotate the message", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    const framesBefore = stream.writes.length;
    vi.advanceTimersByTime(400);
    expect(stream.writes.length).toBeGreaterThan(framesBefore);

    // Cross the second message boundary (1500ms) and assert rotation.
    vi.advanceTimersByTime(1300);
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

  it("stop() clears the line, restores the cursor, and halts the timer", () => {
    const stream = fakeStream();
    const splash = splashOn(stream);
    splash.stop();
    const afterStop = stream.writes.length;
    expect(stream.writes.at(-1)).toBe("\r\x1b[2K\x1b[?25h");
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

  it("is inert off a TTY: zero bytes written, stop() safe", () => {
    const stream = fakeStream(false);
    const splash = splashOn(stream);
    vi.advanceTimersByTime(2000);
    splash.stop();
    expect(stream.writes).toEqual([]);
  });

  it("honors NO_COLOR: frames carry no color escapes but still animate", () => {
    vi.stubEnv("NO_COLOR", "1");
    const stream = fakeStream();
    const splash = splashOn(stream);
    vi.advanceTimersByTime(200);
    // Frames use only the clear-line control; no SGR color/style sequences.
    const frames = stream.writes.filter((w) => w.includes("oxagen"));
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f).not.toContain("[38;2;"); // no truecolor
      expect(f).not.toContain("\x1b[1m"); // no bold
      expect(f).not.toContain("\x1b[2m"); // no dim
    }
    splash.stop();
  });
});
