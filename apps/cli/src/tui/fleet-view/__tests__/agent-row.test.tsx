/**
 * Ink tests for the fleet roster row + header. Both are purely presentational
 * (a function of AgentSnapshot + the shared animation frame), so each case is
 * a static render asserted on the ANSI-stripped frame. Covered: the header
 * columns, every status glyph family (running spinner / queued / done /
 * failed / cancelled), the tier badge labels, the tokens/cost/steps
 * placeholders, and the detail line in its running and failed shapes.
 */
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it } from "vitest";
import { AgentRow, RosterHeader } from "../agent-row.js";
import type { AgentSnapshot } from "../../../agent/fleet/types.js";

/** FORCE_COLOR=3 means frames carry truecolor ANSI; strip it to assert text. */
const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

const agent = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  taskId: "t-1",
  title: "add rate limiting",
  tier: "balanced",
  model: "sonnet",
  status: "running",
  steps: 0,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  logTail: "",
  ...over,
});

const frameOf = (el: React.ReactElement): string => {
  const { lastFrame, unmount } = render(el);
  const frame = strip(lastFrame() ?? "");
  unmount();
  return frame;
};

describe("RosterHeader", () => {
  it("renders every column heading", () => {
    const frame = frameOf(<RosterHeader />);
    for (const heading of [
      "TASK",
      "MODEL",
      "STEPS",
      "ACTIVITY",
      "TOKENS",
      "COST",
    ]) {
      expect(frame).toContain(heading);
    }
  });
});

describe("AgentRow", () => {
  it("renders a running agent with spinner, thinking placeholder, and dashes", () => {
    const frame = frameOf(
      <AgentRow agent={agent()} frame={0} showDetail={false} />,
    );
    expect(frame).toContain("add rate limiting");
    expect(frame).toContain("Sonnet"); // balanced tier badge
    expect(frame).toContain("thinking…"); // running with no lastTool yet
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/); // animated braille glyph
    expect(frame).toContain("—"); // steps / tokens / cost placeholders
  });

  it("shows the last tool, step count, tokens, and cost once accounted", () => {
    const frame = frameOf(
      <AgentRow
        agent={agent({
          status: "running",
          steps: 3,
          lastTool: "edit_file",
          usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.12 },
        })}
        frame={0}
        showDetail={false}
      />,
    );
    expect(frame).toContain("edit_file");
    expect(frame).toContain("3⋯");
    expect(frame).toContain("1.5k"); // humanized 1200 + 300
    expect(frame).toContain("$0.1200");
  });

  it("renders a queued agent as waiting with the hourglass glyph", () => {
    const frame = frameOf(
      <AgentRow
        agent={agent({ status: "queued", tier: "fast" })}
        frame={0}
        showDetail={false}
      />,
    );
    expect(frame).toContain("⧗");
    expect(frame).toContain("waiting");
    expect(frame).toContain("Haiku"); // fast tier badge
  });

  it("renders a done agent with a check and an em-dash activity", () => {
    const frame = frameOf(
      <AgentRow
        agent={agent({ status: "done", tier: "precise" })}
        frame={0}
        showDetail={false}
      />,
    );
    expect(frame).toContain("✓");
    expect(frame).toContain("—"); // settled, no lastTool
    expect(frame).toContain("Fable"); // precise tier badge
  });

  it("hides the detail line when showDetail is off even if a log tail exists", () => {
    const frame = frameOf(
      <AgentRow
        agent={agent({ logTail: "compiling the workspace" })}
        frame={0}
        showDetail={false}
      />,
    );
    expect(frame).not.toContain("compiling the workspace");
  });

  it("shows the failed error on the detail line with the cross prefix", () => {
    const frame = frameOf(
      <AgentRow
        agent={agent({
          status: "failed",
          error: "gateway rejected the call",
          logTail: "old tail",
        })}
        frame={0}
        showDetail={true}
      />,
    );
    expect(frame).toContain("✗ gateway rejected the call");
    expect(frame).not.toContain("old tail"); // error wins over the log tail
  });

  it("shows elapsed seconds and the collapsed log tail while running", () => {
    const startedAt = Date.now() - 5000;
    const frame = frameOf(
      <AgentRow
        agent={agent({
          startedAt,
          finishedAt: startedAt + 5000,
          logTail: "  running   tests\n  now  ",
        })}
        frame={0}
        showDetail={true}
      />,
    );
    // Whitespace runs (including the newline) collapse to single spaces.
    expect(frame).toContain("↳ running tests now");
    expect(frame).toContain("5s ·");
  });

  it("renders a cancelled agent dimly settled, with no detail when the tail is empty", () => {
    const frame = frameOf(
      <AgentRow
        agent={agent({ status: "cancelled", logTail: "" })}
        frame={0}
        showDetail={true}
      />,
    );
    expect(frame).toContain("⊘");
    expect(frame).not.toContain("↳"); // empty detail renders no second line
  });
});
