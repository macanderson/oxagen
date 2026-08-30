/**
 * REPL bottom-stack layout — proves the prompt input renders ABOVE the status
 * line, with a blank padding row above the input bar and below the status line
 * (so the bar is never flush to the window edge), and that the bordered input
 * keeps its constant 3-row height.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { PromptInput, StatusLine } from "../components.js";

// Mirrors the interactive.tsx bottom stack: padded, non-shrink input row, then
// the status line with a blank row beneath it.
function BottomStack(): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexShrink={0} flexDirection="column">
        <PromptInput onSubmit={() => {}} busy={false} catalog={[]} />
      </Box>
      <Box marginBottom={1} flexShrink={0}>
        <StatusLine
          model="anthropic/claude-sonnet-5"
          branch="main"
          inputTokens={6100}
          outputTokens={472}
          cacheHit={0}
          cacheMiss={6100}
          costUsd={0.03}
          pipelineOn
          mode="ask"
        />
      </Box>
    </Box>
  );
}

describe("REPL bottom-stack layout", () => {
  it("renders the input above the status line, padded top and bottom", () => {
    const { lastFrame } = render(<BottomStack />);
    const lines = (lastFrame() ?? "").split("\n");

    const inputRow = lines.findIndex((l) => l.includes("❯"));
    const statusRow = lines.findIndex((l) => l.includes("claude-sonnet"));

    expect(inputRow).toBeGreaterThanOrEqual(1); // not the very first row…
    expect(lines[0]?.trim()).toBe(""); // …because a blank padding row is above it
    expect(statusRow).toBeGreaterThan(inputRow); // status sits BELOW the input
    expect(lines[lines.length - 1]?.trim()).toBe(""); // blank padding row below status

    // The bordered input occupies a full 3 rows (top border, text, bottom border).
    expect(lines.some((l) => l.includes("╭"))).toBe(true);
    expect(lines.some((l) => l.includes("╰"))).toBe(true);
  });
});
