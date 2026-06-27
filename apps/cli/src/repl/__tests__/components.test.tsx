import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  humanizeTokens,
  StatusLine,
  ThinkingIndicator,
} from "../components.js";

describe("humanizeTokens", () => {
  it("formats token counts compactly", () => {
    expect(humanizeTokens(0)).toBe("0");
    expect(humanizeTokens(980)).toBe("980");
    expect(humanizeTokens(1234)).toBe("1.2k");
    expect(humanizeTokens(23000)).toBe("23k");
  });
});

describe("StatusLine (token counter)", () => {
  it("renders the session token counter and model", () => {
    const { lastFrame } = render(
      <StatusLine
        model="anthropic/claude-sonnet-4.5"
        readOnly={false}
        turns={2}
        inputTokens={1234}
        outputTokens={5678}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("tokens:");
    expect(frame).toContain("1.2k"); // input ↑
    expect(frame).toContain("5.7k"); // output ↓
    expect(frame).toContain("claude-sonnet-4.5");
  });

  it("shows a read-only badge when enabled", () => {
    const { lastFrame } = render(
      <StatusLine
        model="x/y"
        readOnly
        turns={0}
        inputTokens={0}
        outputTokens={0}
      />,
    );
    expect(lastFrame() ?? "").toContain("read-only");
  });
});

describe("ThinkingIndicator", () => {
  it("shows the thinking label, elapsed seconds, and live token estimate", () => {
    const { lastFrame, unmount } = render(
      <ThinkingIndicator startedAt={Date.now() - 3000} getTokens={() => 800} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking…");
    expect(frame).toMatch(/\d+s/);
    expect(frame).toContain("800 tok");
    unmount();
  });
});
