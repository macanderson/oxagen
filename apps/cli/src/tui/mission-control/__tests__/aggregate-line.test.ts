/**
 * Tests for the aggregate timeline's editorial rules — every event type maps
 * to exactly the line (or silence) the spec's salience table promises, in
 * both default and verbose modes.
 */
import { describe, expect, it } from "vitest";
import { toAggregateLine } from "../aggregate-line.js";
import type { SessionEvent } from "../../../sessions/events.js";

const base = { v: 1 as const, sid: "s-abc-1234", seq: 1, ts: 1720000000000 };
const ev = (partial: object): SessionEvent =>
  ({ ...base, ...partial }) as SessionEvent;

describe("salient events", () => {
  it("session.start renders the title", () => {
    const line = toAggregateLine(
      ev({
        type: "session.start",
        title: "fix auth bug",
        prompt: "p",
        cwd: "/",
        mode: "conversation",
        owner: "tui",
        pid: 1,
      }),
    );
    expect(line).toMatchObject({
      text: "▶ fix auth bug",
      emphasis: "normal",
      sid: base.sid,
    });
  });

  it("user message renders with the › voice", () => {
    const line = toAggregateLine(
      ev({ type: "message", role: "user", text: "add tests\nplease", turn: 1 }),
    );
    expect(line?.text).toBe("› add tests please");
  });

  it("assistant message.end renders its first non-empty line only", () => {
    const line = toAggregateLine(
      ev({
        type: "message.end",
        text: "\n\nDone. I fixed it.\nDetails follow.",
        turn: 1,
      }),
    );
    expect(line?.text).toBe("⏺ Done. I fixed it.");
  });

  it("empty assistant text renders nothing", () => {
    expect(
      toAggregateLine(ev({ type: "message.end", text: "   \n ", turn: 1 })),
    ).toBeNull();
  });

  it("tool.end ok is dim with human duration; failure is an error line", () => {
    expect(
      toAggregateLine(
        ev({ type: "tool.end", name: "bash", ok: true, durationMs: 1234 }),
      ),
    ).toMatchObject({ text: "· bash 1.2s", emphasis: "dim" });
    expect(
      toAggregateLine(
        ev({
          type: "tool.end",
          name: "edit_file",
          ok: false,
          durationMs: 90_500,
        }),
      ),
    ).toMatchObject({
      text: "✗ edit_file failed after 1m30s",
      emphasis: "error",
    });
    expect(
      toAggregateLine(
        ev({ type: "tool.end", name: "grep", ok: true, durationMs: 12 }),
      )?.text,
    ).toBe("· grep 12ms");
  });

  it("diff summarizes lines and clips the file list at three", () => {
    const line = toAggregateLine(
      ev({
        type: "diff",
        changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
        changedLines: 42,
      }),
    );
    expect(line).toMatchObject({
      text: "± 42 lines · a.ts, b.ts, c.ts +1",
      emphasis: "success",
    });
    expect(
      toAggregateLine(ev({ type: "diff", changedFiles: [], changedLines: 0 })),
    ).toBeNull();
  });

  it("session.end renders fate with summary", () => {
    expect(
      toAggregateLine(
        ev({
          type: "session.end",
          state: "done",
          summary: "shipped",
          durationMs: 1,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        }),
      ),
    ).toMatchObject({ text: "✔ done — shipped", emphasis: "success" });
    expect(
      toAggregateLine(
        ev({
          type: "session.end",
          state: "failed",
          summary: "",
          durationMs: 1,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        }),
      ),
    ).toMatchObject({ text: "✖ failed", emphasis: "error" });
    expect(
      toAggregateLine(
        ev({
          type: "session.end",
          state: "cancelled",
          summary: "x",
          durationMs: 1,
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        }),
      ),
    ).toMatchObject({ text: "◼ cancelled", emphasis: "dim" });
  });

  it("errors always surface", () => {
    expect(
      toAggregateLine(
        ev({ type: "error", message: "rate limited", fatal: false }),
      ),
    ).toMatchObject({ text: "✗ rate limited", emphasis: "error" });
  });
});

describe("noise suppression (default verbosity)", () => {
  it("chatty stages are silent; phase-shift stages show dim", () => {
    expect(
      toAggregateLine(
        ev({ type: "stage", kind: "evaluate", label: "scoring prompt" }),
      ),
    ).toBeNull();
    expect(
      toAggregateLine(
        ev({ type: "stage", kind: "enhance", label: "injecting context" }),
      ),
    ).toBeNull();
    expect(
      toAggregateLine(
        ev({ type: "stage", kind: "route", label: "picking model" }),
      ),
    ).toBeNull();
    expect(
      toAggregateLine(
        ev({
          type: "stage",
          kind: "execute",
          label: "executing",
          detail: "sonnet-5",
        }),
      ),
    ).toMatchObject({ text: "executing — sonnet-5", emphasis: "dim" });
    expect(
      toAggregateLine(ev({ type: "stage", kind: "judge", label: "judging" }))
        ?.emphasis,
    ).toBe("dim");
  });

  it("deltas, tool.start, usage, reasoning, and running-state are silent", () => {
    expect(
      toAggregateLine(ev({ type: "message.delta", text: "chunk", turn: 1 })),
    ).toBeNull();
    expect(
      toAggregateLine(ev({ type: "tool.start", name: "bash", input: "{}" })),
    ).toBeNull();
    expect(
      toAggregateLine(
        ev({
          type: "usage",
          cumulative: { inputTokens: 1, outputTokens: 2, costUsd: 0.1 },
        }),
      ),
    ).toBeNull();
    expect(
      toAggregateLine(ev({ type: "reasoning.delta", text: "hmm", turn: 1 })),
    ).toBeNull();
    expect(
      toAggregateLine(ev({ type: "session.state", state: "running" })),
    ).toBeNull();
  });

  it("waiting state shows dim (the operator's cue to reply)", () => {
    expect(
      toAggregateLine(ev({ type: "session.state", state: "waiting" })),
    ).toMatchObject({ text: "◇ waiting for input", emphasis: "dim" });
  });
});

describe("verbose mode", () => {
  it("adds every stage, tool.start, and message deltas", () => {
    const opts = { verbose: true };
    expect(
      toAggregateLine(
        ev({ type: "stage", kind: "evaluate", label: "scoring" }),
        opts,
      )?.text,
    ).toBe("scoring");
    expect(
      toAggregateLine(
        ev({ type: "tool.start", name: "bash", input: "{}" }),
        opts,
      )?.text,
    ).toBe("· bash …");
    expect(
      toAggregateLine(
        ev({ type: "message.delta", text: "partial", turn: 1 }),
        opts,
      )?.text,
    ).toBe("partial");
    expect(
      toAggregateLine(
        ev({ type: "reasoning.delta", text: "hmm", turn: 1 }),
        opts,
      ),
    ).toBeNull();
  });
});

describe("clipping", () => {
  it("long titles and messages clip with an ellipsis", () => {
    const long = "x".repeat(500);
    const start = toAggregateLine(
      ev({
        type: "session.start",
        title: long,
        prompt: "p",
        cwd: "/",
        mode: "once",
        owner: "worker",
        pid: 2,
      }),
    );
    expect(start?.text.length).toBeLessThanOrEqual(102);
    expect(start?.text.endsWith("…")).toBe(true);
    const end = toAggregateLine(
      ev({ type: "message.end", text: long, turn: 1 }),
    );
    expect(end?.text.endsWith("…")).toBe(true);
  });
});
