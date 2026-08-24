/**
 * Ink tests for the fleet header band. A pure function of FleetSnapshot, so
 * each case is a static render asserted on the ANSI-stripped frame: the
 * wordmark + concurrency line, the running/queued/done vitals, the
 * failed-count branch (hidden at zero), and the token + cost totals.
 */
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { FleetSummary } from "../fleet-summary.js";
import type { FleetSnapshot } from "../../../agent/fleet/types.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

const snap = (over: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
  agents: [],
  queuedCount: 0,
  runningCount: 0,
  doneCount: 0,
  failedCount: 0,
  totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  concurrency: 4,
  ...over,
});

const frameOf = (s: FleetSnapshot): string => {
  const { lastFrame, unmount } = render(<FleetSummary snap={s} />);
  const frame = strip(lastFrame() ?? "");
  unmount();
  return frame;
};

describe("FleetSummary", () => {
  it("renders the wordmark line with the concurrency cap", () => {
    const frame = frameOf(snap({ concurrency: 6 }));
    expect(frame).toContain("OXAGEN");
    expect(frame).toContain("agent fleet");
    expect(frame).toContain("6× concurrency");
  });

  it("renders zeroed vitals with no failed segment", () => {
    const frame = frameOf(snap());
    expect(frame).toContain("0"); // running count
    expect(frame).toContain("running");
    expect(frame).toContain("0 queued");
    expect(frame).toContain("✓ 0");
    expect(frame).toContain("done");
    expect(frame).not.toContain("failed");
    expect(frame).toContain("$0"); // formatUsd(0)
  });

  it("renders live counts, the failed segment, and token + cost totals", () => {
    const frame = frameOf(
      snap({
        runningCount: 2,
        queuedCount: 3,
        doneCount: 5,
        failedCount: 1,
        totals: { inputTokens: 1000, outputTokens: 500, costUsd: 0.25 },
      }),
    );
    expect(frame).toContain("2");
    expect(frame).toContain("running");
    expect(frame).toContain("3 queued");
    expect(frame).toContain("✓ 5");
    expect(frame).toContain("✗ 1 failed");
    expect(frame).toContain("1.5k"); // humanized 1000 + 500
    expect(frame).toContain("tok");
    expect(frame).toContain("$0.2500");
  });
});
