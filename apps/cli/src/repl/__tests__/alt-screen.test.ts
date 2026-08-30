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
  parseMouseButtonEvents,
  isStrayMouseReportRemnant,
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
    expect(joined.indexOf("\x1b[?25h")).toBeLessThan(
      joined.indexOf("\x1b[?1049l"),
    );
  });

  it("leave() ALSO disarms SGR mouse tracking (modes 1000/1002/1006) — a signal-kill (SIGTERM/SIGINT) tears the process down before React's own use-mouse-wheel cleanup ever runs, so this is the only backstop that keeps a killed CLI from stranding the user's terminal reporting raw mouse escapes into their shell", () => {
    const { stream, writes } = fakeStream();
    const handle = enterFullscreen(stream);
    writes.length = 0; // isolate the leave() writes
    handle.leave();
    const joined = writes.join("");
    expect(joined).toContain("\x1b[?1000l");
    expect(joined).toContain("\x1b[?1002l");
    expect(joined).toContain("\x1b[?1006l");
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
  it("writes the SGR mouse-tracking arm/disarm sequences, including button+drag tracking (mode 1002)", () => {
    const { stream, writes } = fakeStream();
    enableMouseReporting(stream);
    expect(writes.join("")).toBe("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    writes.length = 0;
    disableMouseReporting(stream);
    expect(writes.join("")).toBe("\x1b[?1000l\x1b[?1002l\x1b[?1006l");
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
    expect(parseMouseWheelEvents("\x1b[<68;1;1M")).toEqual([
      { direction: "up" },
    ]);
    expect(parseMouseWheelEvents("\x1b[<81;1;1M")).toEqual([
      { direction: "down" },
    ]);
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
    const events = parseMouseWheelEvents(
      "\x1b[<64;1;1M\x1b[<65;2;2M\x1b[<64;3;3M",
    );
    expect(events).toEqual([
      { direction: "up" },
      { direction: "down" },
      { direction: "up" },
    ]);
  });

  it("handles the release form (lowercase m) the same as press", () => {
    expect(parseMouseWheelEvents("\x1b[<64;1;1m")).toEqual([
      { direction: "up" },
    ]);
  });
});

describe("parseMouseButtonEvents", () => {
  it("recognizes a left-button press (Cb=0)", () => {
    expect(parseMouseButtonEvents("\x1b[<0;12;5M")).toEqual([
      { type: "press", col: 12, row: 5 },
    ]);
  });

  it("recognizes a left-button drag (Cb=32 — button 0 + the motion bit)", () => {
    expect(parseMouseButtonEvents("\x1b[<32;20;5M")).toEqual([
      { type: "drag", col: 20, row: 5 },
    ]);
  });

  it("recognizes a release (lowercase m) regardless of the reported button bits", () => {
    expect(parseMouseButtonEvents("\x1b[<0;12;5m")).toEqual([
      { type: "release", col: 12, row: 5 },
    ]);
    // Some terminals report 3 ("no button") on release rather than the
    // originally-pressed button — must still finalize the drag.
    expect(parseMouseButtonEvents("\x1b[<3;12;5m")).toEqual([
      { type: "release", col: 12, row: 5 },
    ]);
  });

  it("ignores middle/right-button press and drag — left for native terminal handling", () => {
    expect(parseMouseButtonEvents("\x1b[<1;10;10M")).toEqual([]); // middle press
    expect(parseMouseButtonEvents("\x1b[<2;10;10M")).toEqual([]); // right press
    expect(parseMouseButtonEvents("\x1b[<33;10;10M")).toEqual([]); // middle drag
  });

  it("ignores wheel reports (bit 6/64) — parseMouseWheelEvents's territory", () => {
    expect(parseMouseButtonEvents("\x1b[<64;1;1M")).toEqual([]);
    expect(parseMouseButtonEvents("\x1b[<65;1;1M")).toEqual([]);
  });

  it("classifies a modified press (shift/meta/ctrl bits set) the same as a plain one", () => {
    // 0 + 4 (shift) = 4 — still button 0, no motion bit.
    expect(parseMouseButtonEvents("\x1b[<4;1;1M")).toEqual([
      { type: "press", col: 1, row: 1 },
    ]);
  });

  it("extracts a full press -> drag -> drag -> release sequence from one chunk, in order", () => {
    const chunk =
      "\x1b[<0;5;10M" + "\x1b[<32;8;10M" + "\x1b[<32;12;10M" + "\x1b[<0;12;10m";
    expect(parseMouseButtonEvents(chunk)).toEqual([
      { type: "press", col: 5, row: 10 },
      { type: "drag", col: 8, row: 10 },
      { type: "drag", col: 12, row: 10 },
      { type: "release", col: 12, row: 10 },
    ]);
  });

  it("ignores chunks with no mouse escape sequence at all", () => {
    expect(parseMouseButtonEvents("hello world")).toEqual([]);
    expect(parseMouseButtonEvents("")).toEqual([]);
  });
});

describe("isStrayMouseReportRemnant", () => {
  it("recognizes Ink's ESC-stripped remnant of a press/release report", () => {
    expect(isStrayMouseReportRemnant("[<0;6;10M")).toBe(true);
    expect(isStrayMouseReportRemnant("[<0;6;10m")).toBe(true);
  });

  it("recognizes the remnant of a drag report (motion bit set)", () => {
    expect(isStrayMouseReportRemnant("[<32;6;10M")).toBe(true);
  });

  it("recognizes the remnant of a wheel report (bit 6 set) — the pre-existing scroll bug this also closes", () => {
    expect(isStrayMouseReportRemnant("[<64;12;5M")).toBe(true);
    expect(isStrayMouseReportRemnant("[<65;12;5m")).toBe(true);
  });

  it("does not match ordinary typed text", () => {
    expect(isStrayMouseReportRemnant("hello")).toBe(false);
    expect(isStrayMouseReportRemnant("a")).toBe(false);
    expect(isStrayMouseReportRemnant("")).toBe(false);
  });

  it("does not match a still-ESC-prefixed report (Ink always strips it first — this only matches AFTER stripping)", () => {
    expect(isStrayMouseReportRemnant("\x1b[<0;6;10M")).toBe(false);
  });

  it("does not match a superficially similar but malformed string", () => {
    expect(isStrayMouseReportRemnant("[<0;6;10")).toBe(false); // missing M/m terminator
    expect(isStrayMouseReportRemnant("[<a;6;10M")).toBe(false); // non-numeric Cb
  });
});
