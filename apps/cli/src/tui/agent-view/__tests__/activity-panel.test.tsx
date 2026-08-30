/**
 * Ink tests for the agent-view activity panel. A pure function of the folded
 * ActivityLine list, so each case is a static render asserted on the
 * ANSI-stripped frame: the header + live-surface pointer, the real empty
 * state, and one line per emphasis class (success / error / dim / normal).
 */
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { ActivityPanel } from "../activity-panel.js";
import type { ActivityLine } from "../data.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

const line = (over: Partial<ActivityLine> = {}): ActivityLine => ({
  sid: "s-test-7f2q",
  ts: Date.parse("2026-08-23T12:34:56"),
  text: "edited src/lib.rs",
  emphasis: "normal",
  ...over,
});

const frameOf = (lines: ActivityLine[]): string => {
  const { lastFrame, unmount } = render(<ActivityPanel lines={lines} />);
  const frame = strip(lastFrame() ?? "");
  unmount();
  return frame;
};

describe("ActivityPanel", () => {
  it("shows the real empty state with the header and live pointer", () => {
    const frame = frameOf([]);
    expect(frame).toContain("RECENT ACTIVITY");
    expect(frame).toContain("newest run");
    expect(frame).toContain("live: oxagen fleet watch");
    expect(frame).toContain("No recorded events yet.");
  });

  it("renders one row per line across every emphasis class", () => {
    const frame = frameOf([
      line({ text: "tests passed", emphasis: "success" }),
      line({ text: "bash failed", emphasis: "error" }),
      line({ text: "compacting context", emphasis: "dim" }),
      line({ text: "edited src/lib.rs", emphasis: "normal" }),
    ]);
    expect(frame).toContain("tests passed");
    expect(frame).toContain("bash failed");
    expect(frame).toContain("compacting context");
    expect(frame).toContain("edited src/lib.rs");
    expect(frame).toContain("12:34"); // formatClock on the timestamp
    expect(frame).toContain("▏"); // per-session colour bar
    expect(frame).not.toContain("No recorded events yet.");
  });
});
