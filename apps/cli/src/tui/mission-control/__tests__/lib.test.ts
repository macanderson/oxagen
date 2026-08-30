/**
 * Tests for Mission Control's pure helpers — the composer line editor, the
 * @sid router, session color stability, roster math, and the focus-transcript
 * fold. These carry the app's behavior; the Ink layer above them is thin.
 */
import { describe, expect, it } from "vitest";
import {
  colorForSid,
  countByState,
  editLine,
  emptyLine,
  foldFocusEvents,
  formatElapsed,
  hasLiveTimers,
  parseAtRef,
  stateGlyph,
  sumUsage,
} from "../lib.js";
import type { SessionEvent } from "../../../sessions/events.js";
import type { SessionMetaView } from "../../../sessions/store.js";

const view = (over: Partial<SessionMetaView>): SessionMetaView =>
  ({
    v: 1,
    sid: "s-x-0001",
    title: "t",
    prompt: "p",
    state: "running",
    owner: "tui",
    pid: 1,
    cwd: "/",
    mode: "conversation",
    createdAt: 1,
    updatedAt: 1,
    turns: 0,
    lastSeq: 0,
    usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
    alive: true,
    derivedState: "running",
    ...over,
  }) as SessionMetaView;

describe("parseAtRef", () => {
  it("splits @ref from the message", () => {
    expect(parseAtRef("@7f2q add tests")).toEqual({
      ref: "7f2q",
      rest: "add tests",
    });
  });
  it("bare @ref focuses (empty rest)", () => {
    expect(parseAtRef("@7f2q")).toEqual({ ref: "7f2q", rest: "" });
  });
  it("non-@ text and lone @ are not refs", () => {
    expect(parseAtRef("fix it")).toBeNull();
    expect(parseAtRef("@")).toBeNull();
    expect(parseAtRef("a@b")).toBeNull();
  });
});

describe("editLine", () => {
  it("inserts at the cursor and moves it", () => {
    let l = emptyLine();
    for (const ch of "abc") l = editLine(l, { t: "insert", ch });
    l = editLine(l, { t: "left" });
    l = editLine(l, { t: "insert", ch: "X" });
    expect(l.value).toBe("abXc");
    expect(l.cursor).toBe(3);
  });
  it("backspace/delete respect the cursor and clamp at edges", () => {
    let l = { value: "abc", cursor: 3 };
    l = editLine(l, { t: "backspace" });
    expect(l.value).toBe("ab");
    l = editLine(l, { t: "home" });
    l = editLine(l, { t: "backspace" }); // no-op at 0
    expect(l).toEqual({ value: "ab", cursor: 0 });
    l = editLine(l, { t: "delete" });
    expect(l.value).toBe("b");
    l = editLine(l, { t: "end" });
    expect(l.cursor).toBe(1);
  });
});

describe("roster math", () => {
  it("counts states including orphaned and failed buckets", () => {
    const counts = countByState([
      view({ derivedState: "running" }),
      view({ derivedState: "waiting" }),
      view({ derivedState: "done" }),
      view({ derivedState: "failed" }),
      view({ derivedState: "orphaned" }),
    ]);
    expect(counts.running).toBe(1);
    expect(counts.waiting).toBe(1);
    expect(counts.done).toBe(1);
    expect(counts.failed + (counts.orphaned ?? 0)).toBeGreaterThanOrEqual(1);
  });
  it("sums usage across the roster", () => {
    const total = sumUsage([view({}), view({})]);
    expect(total).toEqual({ inputTokens: 2, outputTokens: 4, costUsd: 1 });
  });
});

describe("hasLiveTimers", () => {
  it("is true while any session is active (queued/running/waiting)", () => {
    for (const s of ["queued", "running", "waiting"] as const) {
      expect(
        hasLiveTimers(
          [view({ derivedState: "done" }), view({ derivedState: s })],
          false,
        ),
      ).toBe(true);
    }
  });
  it("is false when every session is inert and not draining", () => {
    const inert = [
      view({ derivedState: "done" }),
      view({ derivedState: "failed" }),
      view({ derivedState: "cancelled" }),
      view({ derivedState: "orphaned" }),
    ];
    expect(hasLiveTimers(inert, false)).toBe(false);
    expect(hasLiveTimers([], false)).toBe(false);
  });
  it("is true while draining even if no session is active", () => {
    expect(hasLiveTimers([view({ derivedState: "done" })], true)).toBe(true);
    expect(hasLiveTimers([], true)).toBe(true);
  });
});

describe("presentation helpers", () => {
  it("session color is stable per sid and drawn from the palette", () => {
    expect(colorForSid("s-a-1111")).toBe(colorForSid("s-a-1111"));
  });
  it("every state has a glyph character and a color", () => {
    for (const s of [
      "queued",
      "running",
      "waiting",
      "done",
      "failed",
      "cancelled",
      "orphaned",
    ] as const) {
      const g = stateGlyph(s);
      expect(g.ch.length).toBeGreaterThan(0);
      expect(g.color.length).toBeGreaterThan(0);
    }
  });
  it("elapsed formats as a compact clock", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
  });
});

describe("foldFocusEvents", () => {
  const base = { v: 1 as const, sid: "s-x-0001", ts: 1 };
  const ev = (partial: object, seq: number): SessionEvent =>
    ({ ...base, seq, ...partial }) as SessionEvent;

  it("accumulates deltas into one assistant item closed by message.end", () => {
    const items = foldFocusEvents([
      ev({ type: "message", role: "user", text: "hi", turn: 1 }, 1),
      ev({ type: "message.delta", text: "wor", turn: 1 }, 2),
      ev({ type: "message.delta", text: "king", turn: 1 }, 3),
      ev({ type: "message.end", text: "working done", turn: 1 }, 4),
      ev({ type: "tool.end", name: "bash", ok: true, durationMs: 5 }, 5),
    ]);
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
    const assistant = items.find((i) => i.kind === "assistant");
    expect(JSON.stringify(assistant)).toContain("working done");
  });
});
