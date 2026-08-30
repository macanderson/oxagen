/**
 * Render proof for the Group 8 status-line + diff UI.
 *
 * These assert the new pieces actually render in an Ink terminal:
 *  - StatusLine shows a live "▲ turn +…" chip when the current turn has burned
 *    tokens/cost (Bug 2 — the developer sees per-turn burn, not just a session
 *    total that only moves at the end).
 *  - DiffMessage renders a file header + the unified diff's added/removed code
 *    (Feature B — code changes shown as a syntax-highlighted git diff).
 *  - ThinkingIndicator surfaces an "idle" figure once progress stalls, instead
 *    of a countdown to a (now-removed) wall-clock deadline (Bug 1).
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import {
  StatusLine,
  DiffMessage,
  ThinkingIndicator,
  type Message,
} from "../components.js";
import { LIGHT_DIFF_THEME, DARK_DIFF_THEME } from "../../tui/terminal-theme.js";

describe("StatusLine — live turn burn (Bug 2)", () => {
  it("shows a turn chip with the current turn's output tokens + cost", () => {
    const { lastFrame, unmount } = render(
      <StatusLine
        model="anthropic/claude-sonnet-5"
        inputTokens={12_000}
        outputTokens={3_400}
        cacheHit={5_000}
        cacheMiss={7_000}
        costUsd={0.42}
        turnOutputTokens={1_200}
        turnCostUsd={0.05}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("▲ turn +");
    expect(frame).toContain("1.2k");
    unmount();
  });

  it("hides the turn chip when the turn has burned nothing yet", () => {
    const { lastFrame, unmount } = render(
      <StatusLine
        model="m"
        inputTokens={0}
        outputTokens={0}
        cacheHit={0}
        cacheMiss={0}
        costUsd={0}
        turnOutputTokens={0}
        turnCostUsd={0}
      />,
    );
    expect(lastFrame() ?? "").not.toContain("▲ turn");
    unmount();
  });
});

describe("DiffMessage — highlighted git diff (Feature B/C)", () => {
  const SAMPLE_DIFF = [
    "diff --git a/src/hello.ts b/src/hello.ts",
    "index 1111111..2222222 100644",
    "--- a/src/hello.ts",
    "+++ b/src/hello.ts",
    "@@ -1,2 +1,2 @@",
    "-const greeting = 'hi'",
    "+const greeting = 'hello'",
    " export { greeting }",
  ].join("\n");

  function diffMsg(): Message {
    return {
      role: "diff",
      content: "",
      diff: SAMPLE_DIFF,
      changedFiles: ["src/hello.ts"],
      timestamp: 0,
    };
  }

  it("renders the file header and the changed code (dark theme)", () => {
    const { lastFrame, unmount } = render(
      <DiffMessage msg={diffMsg()} theme={DARK_DIFF_THEME} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("src/hello.ts");
    expect(frame).toContain("greeting");
    expect(frame).toContain("hello");
    unmount();
  });

  it("renders with the light theme without throwing", () => {
    const { lastFrame, unmount } = render(
      <DiffMessage msg={diffMsg()} theme={LIGHT_DIFF_THEME} />,
    );
    expect(lastFrame() ?? "").toContain("src/hello.ts");
    unmount();
  });

  it("shows a multi-file header when several files changed", () => {
    const msg: Message = {
      role: "diff",
      content: "",
      diff: "diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+x",
      changedFiles: ["a.ts", "b.ts", "c.ts"],
      timestamp: 0,
    };
    const { lastFrame, unmount } = render(
      <DiffMessage msg={msg} theme={DARK_DIFF_THEME} />,
    );
    expect(lastFrame() ?? "").toContain("3 files changed");
    unmount();
  });
});

describe("ThinkingIndicator — idle since last progress (Bug 1)", () => {
  it("surfaces a 'still working' heartbeat reassurance once progress stalls (no countdown-to-cancel)", () => {
    // Superseded by the HEARTBEAT_SEC reassurance system: past HEARTBEAT_SEC
    // (8s) of silence the indicator swaps "Thinking…" for "Still working…"
    // and appends a "working Ns" chip naming how long progress has stalled,
    // instead of the old bare "idle" label. There is still no countdown-to-
    // auto-cancel wording ("left") — a turn is bounded by progress/per-call
    // timeouts, not total elapsed time.
    const { lastFrame, unmount } = render(
      <ThinkingIndicator
        startedAt={Date.now() - 120_000}
        getTokens={() => 0}
        getLastProgressAt={() => Date.now() - 90_000} // 90s since last progress
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Still working…");
    expect(frame).toContain("working 90s");
    // The old countdown wording must be gone.
    expect(frame).not.toContain("left");
    unmount();
  });

  it("stays clean (no heartbeat chip) when progress is fresh", () => {
    const { lastFrame, unmount } = render(
      <ThinkingIndicator
        startedAt={Date.now() - 3_000}
        getTokens={() => 200}
        getLastProgressAt={() => Date.now()}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Thinking…");
    expect(frame).not.toContain("Still working…");
    expect(frame).not.toContain("working ");
    unmount();
  });
});
