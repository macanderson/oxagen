/**
 * Unit tests for the full-screen mode's raw terminal control: alternate-screen
 * enter/leave sequencing and SGR mouse-wheel event parsing. Plain string
 * assertions against a fake WriteStream — no Ink, no real terminal.
 */
import { describe, it, expect, vi } from "vitest";
import {
  enterFullscreen,
  enableMouseReporting,
  disableMouseReporting,
  parseMouseWheelEvents,
} from "../alt-screen.js";

function fakeStream(): { stream: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const stream = {
    write: vi.fn((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }),
  } as unknown as NodeJS.WriteStream;
  return { stream, writes };
}

describe("enterFullscreen", () => {
  it("writes the enter-alt-screen + hide-cursor sequence on entry", () => {
    const { stream, writes } = fakeStream();
    enterFullscreen(stream);
    expect(writes.join("")).toContain("\x1b[?1049h");
    expect(writes.join("")).toContain("\x1b[?25l");
  });

  it("leave() writes show-cursor + leave-alt-screen, in that order", () => {
    const { stream, writes } = fakeStream();
    const handle = enterFullscreen(stream);
    writes.length = 0; // isolate the leave() writes
    handle.leave();
    const joined = writes.join("");
    expect(joined).toContain("\x1b[?25h");
    expect(joined).toContain("\x1b[?1049l");
    expect(joined.indexOf("\x1b[?25h")).toBeLessThan(joined.indexOf("\x1b[?1049l"));
  });

  it("leave() is idempotent — a second call writes nothing further", () => {
    const { stream, writes } = fakeStream();
    const handle = enterFullscreen(stream);
    handle.leave();
    writes.length = 0;
    handle.leave();
    expect(writes).toEqual([]);
  });
});

describe("enableMouseReporting / disableMouseReporting", () => {
  it("writes the SGR mouse-tracking arm/disarm sequences", () => {
    const { stream, writes } = fakeStream();
    enableMouseReporting(stream);
    expect(writes.join("")).toBe("\x1b[?1000h\x1b[?1006h");
    writes.length = 0;
    disableMouseReporting(stream);
    expect(writes.join("")).toBe("\x1b[?1000l\x1b[?1006l");
  });
});

describe("parseMouseWheelEvents", () => {
  it("recognizes a wheel-up SGR report (Cb=64)", () => {
    const events = parseMouseWheelEvents("\x1b[<64;12;5M");
    expect(events).toEqual([{ direction: "up" }]);
  });

  it("recognizes a wheel-down SGR report (Cb=65)", () => {
    const events = parseMouseWheelEvents("\x1b[<65;12;5M");
    expect(events).toEqual([{ direction: "down" }]);
  });

  it("classifies modified wheel events (shift/meta/ctrl bits) by the same up/down bit", () => {
    // 64 + 4 (shift) = 68 → still "up"; 65 + 16 (ctrl) = 81 → still "down".
    expect(parseMouseWheelEvents("\x1b[<68;1;1M")).toEqual([{ direction: "up" }]);
    expect(parseMouseWheelEvents("\x1b[<81;1;1M")).toEqual([{ direction: "down" }]);
  });

  it("ignores non-wheel mouse reports (clicks, drags, plain moves)", () => {
    // Cb=0 is a plain left-button press — bit 6 (64) is not set.
    expect(parseMouseWheelEvents("\x1b[<0;10;10M")).toEqual([]);
    expect(parseMouseWheelEvents("\x1b[<0;10;10m")).toEqual([]);
  });

  it("ignores chunks with no mouse escape sequence at all", () => {
    expect(parseMouseWheelEvents("hello world")).toEqual([]);
    expect(parseMouseWheelEvents("")).toEqual([]);
  });

  it("extracts multiple wheel events from a single chunk", () => {
    const events = parseMouseWheelEvents("\x1b[<64;1;1M\x1b[<65;2;2M\x1b[<64;3;3M");
    expect(events).toEqual([{ direction: "up" }, { direction: "down" }, { direction: "up" }]);
  });

  it("handles the release form (lowercase m) the same as press", () => {
    expect(parseMouseWheelEvents("\x1b[<64;1;1m")).toEqual([{ direction: "up" }]);
  });
});
