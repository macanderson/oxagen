import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  ApprovalPrompt,
  humanizeTokens,
  modeLabel,
  StatusLine,
  ThinkingIndicator,
} from "../components.js";
import type { ApprovalRequest, ApprovalResponse } from "../../agent/permissions.js";

const sampleReq: ApprovalRequest = {
  tool: "bash",
  command: "rm -rf build",
  cwd: "/x",
  summary: "Run: rm -rf build",
  reason: "command matches a dangerous pattern",
};

/** Ink delivers stdin to useInput on a microtask; let it settle before asserting. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

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

describe("StatusLine (permission mode)", () => {
  it("shows the mode chip when a mode is provided", () => {
    const { lastFrame } = render(
      <StatusLine
        model="x/y"
        readOnly={false}
        turns={0}
        inputTokens={0}
        outputTokens={0}
        mode="acceptEdits"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("mode:");
    expect(frame).toContain("auto-edit");
  });
});

describe("modeLabel", () => {
  it("maps modes to friendly labels", () => {
    expect(modeLabel("acceptEdits")).toBe("auto-edit");
    expect(modeLabel("readonly")).toBe("read-only");
    expect(modeLabel("ask")).toBe("ask");
    expect(modeLabel("bypass")).toBe("bypass");
  });
});

describe("ApprovalPrompt", () => {
  it("renders the call summary and the reason it is asking", () => {
    const { lastFrame, unmount } = render(
      <ApprovalPrompt req={sampleReq} onResolve={() => {}} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Run: rm -rf build");
    expect(frame).toContain("dangerous");
    expect(frame).toContain("allow once");
    unmount();
  });

  it("resolves allow on 'y', allow+remember on 'a', deny on 'n'", async () => {
    for (const [key, expected] of [
      ["y", { decision: "allow" }],
      ["a", { decision: "allow", remember: true }],
      ["n", { decision: "deny" }],
    ] as Array<[string, ApprovalResponse]>) {
      const calls: ApprovalResponse[] = [];
      const { stdin, unmount } = render(
        <ApprovalPrompt req={sampleReq} onResolve={(r) => calls.push(r)} />,
      );
      stdin.write(key);
      await tick();
      expect(calls).toEqual([expected]);
      unmount();
    }
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
