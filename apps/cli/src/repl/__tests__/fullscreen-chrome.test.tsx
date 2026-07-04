/**
 * Structural render tests for the full-screen TUI's presentational chrome —
 * HeaderBar, TranscriptViewport, TelemetryDock — rendered directly via
 * ink-testing-library (non-TTY; these components don't care about TTY-ness
 * themselves, only their caller in interactive.tsx does). Proves the pieces
 * render correctly in isolation with fixture props; NOT a substitute for
 * confirming real-terminal layout/scroll, which needs the user's own TTY —
 * see the PR description.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { HeaderBar, TranscriptViewport, TelemetryDock, formatClock, formatElapsed, dockPanelWidth } from "../fullscreen-chrome.js";
import { INITIAL_SCROLL_STATE, type ScrollState } from "../scroll.js";
import { INITIAL_TELEMETRY_STATE, type TelemetryState } from "../telemetry.js";
import type { Message } from "../components.js";
import type { SessionMetrics } from "../../agent/metrics.js";
import type { RepoInfo } from "../use-repo-info.js";

function emptyMetrics(): SessionMetrics {
  return {
    turnTokensIn: 0,
    turnTokensOut: 0,
    turnCachedTokens: 0,
    turnCostUsd: 0,
    sessionTokensIn: 0,
    sessionTokensOut: 0,
    sessionCachedTokens: 0,
    sessionCostUsd: 0,
    byModel: {},
  };
}

function fixtureRepo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return { root: "/Users/mac/Workspaces/oxagen-repl2", branch: "feat/x", prNumber: 486, ...overrides };
}

describe("formatClock", () => {
  it("formats as zero-padded 24h HH:MM:SS", () => {
    const d = new Date(2026, 0, 1, 9, 5, 3);
    expect(formatClock(d.getTime())).toBe("09:05:03");
  });
});

describe("formatElapsed", () => {
  it("shows seconds under a minute", () => {
    expect(formatElapsed(12_000)).toBe("12s");
  });
  it("shows minutes+seconds at/above a minute", () => {
    expect(formatElapsed(64_000)).toBe("1m04s");
  });
});

describe("HeaderBar", () => {
  it("renders the brand mark, session label, model, clock, and cost", () => {
    const { lastFrame } = render(
      <HeaderBar
        model="anthropic/claude-sonnet-5"
        branch="main"
        sessionLabel="oxagen-repl2"
        sessionCostUsd={1.23}
        now={new Date(2026, 0, 1, 10, 0, 0).getTime()}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("OXAGEN");
    expect(frame).toContain("oxagen-repl2");
    expect(frame).toContain("main");
    expect(frame).toContain("claude-sonnet-5");
    expect(frame).toContain("10:00:00");
    expect(frame).toContain("$1.23");
  });
});

describe("TranscriptViewport", () => {
  const scroll: ScrollState = INITIAL_SCROLL_STATE;

  it("renders committed messages within the bounded viewport", () => {
    const messages: Message[] = [
      { role: "user", content: "hello there", timestamp: 1 },
      { role: "assistant", content: "hi back", timestamp: 2 },
    ];
    const { lastFrame } = render(
      <TranscriptViewport committedMessages={messages} width={80} height={10} scroll={scroll} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello there");
    expect(frame).toContain("hi back");
  });

  it("renders the live (streaming) message alongside committed ones", () => {
    const committed: Message[] = [{ role: "user", content: "do the thing", timestamp: 1 }];
    const live: Message = { role: "assistant", content: "working on it", timestamp: 2, streaming: true };
    const { lastFrame } = render(
      <TranscriptViewport committedMessages={committed} liveMessage={live} width={80} height={10} scroll={scroll} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("do the thing");
    expect(frame).toContain("working on it");
  });

  it("shows the scrolled-up indicator (not the bottom) when scroll offset isn't at the max", () => {
    // Enough messages that the estimated content exceeds a tiny viewport, and an
    // explicit non-sticky offset away from the bottom.
    const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
      role: "assistant" as const,
      content: `message number ${i}`,
      timestamp: i,
    }));
    const scrolledUp: ScrollState = { rawOffset: 0, stickyBottom: false };
    const { lastFrame } = render(
      <TranscriptViewport committedMessages={messages} width={80} height={5} scroll={scrolledUp} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("lines above");
    expect(frame).toContain("End to jump");
  });

  it("renders nothing but empty space for an empty transcript, without crashing", () => {
    const { lastFrame } = render(<TranscriptViewport committedMessages={[]} width={80} height={5} scroll={scroll} />);
    expect(lastFrame()).toBeDefined();
  });
});

describe("TelemetryDock", () => {
  it("renders all five captioned panels with their live values", () => {
    // ink-testing-library's mocked stdout is a FIXED 100 columns (see its own
    // source) regardless of the `cols` prop passed here, so — exactly as in a
    // real ~100-col terminal — a 5-panel dock has room for short model names
    // but not long slugs; long-slug truncation is covered by its own test
    // below, using the SAME cols value a real caller would (see interactive.tsx,
    // which always sources `cols` from the real useTerminalSize()).
    const telemetry: TelemetryState = {
      models: { planner: "haiku", worker: "sonnet", judge: "opus" },
      turn: { phase: "execute", step: 7, maxStep: 256, reviseRound: 1, turnStartedAt: 0 },
      tools: { code_graph: 2, edit_file: 3, write_file: 1, read_file: 4, bash: 5, grep: 6 },
    };
    const metrics: SessionMetrics = {
      ...emptyMetrics(),
      sessionTokensIn: 12_000,
      sessionTokensOut: 3_400,
      sessionCostUsd: 0.42,
    };
    const { lastFrame } = render(
      <TelemetryDock
        telemetry={telemetry}
        metrics={metrics}
        cacheHit={500}
        isStreaming={true}
        now={5000}
        cols={100}
        repo={fixtureRepo({ root: "/Users/mac/oxagen-repl2", branch: "main", prNumber: 42 })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("MODELS");
    expect(frame).toContain("TURN");
    expect(frame).toContain("TOKENS");
    expect(frame).toContain("TOOLS");
    expect(frame).toContain("REPO");
    expect(frame).toContain("haiku");
    expect(frame).toContain("sonnet");
    expect(frame).toContain("opus");
    expect(frame).toContain("execute");
    expect(frame).toContain("7/256");
    expect(frame).toContain("code_graph 2");
    expect(frame).toContain("bash 5");
    expect(frame).toContain("main");
    expect(frame).toContain("#42");
    expect(frame).toContain("oxagen-repl2"); // tail of the worktree root path
  });

  it("truncates a long model slug rather than overflowing a narrow panel", () => {
    const telemetry: TelemetryState = {
      ...INITIAL_TELEMETRY_STATE,
      models: { worker: "some-vendor/a-very-long-model-slug-name-indeed" },
    };
    const { lastFrame } = render(
      <TelemetryDock
        telemetry={telemetry}
        metrics={emptyMetrics()}
        cacheHit={0}
        isStreaming={false}
        now={0}
        cols={80} // narrow dock — five ~14-16 col panels
        repo={fixtureRepo()}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("some-vendor/a-very-long-model-slug-name-indeed");
    // Ink's wrap="truncate-end" ellipsis — proves it degrades gracefully
    // instead of wrapping or blowing out the panel's fixed width.
    expect(frame).toContain("…");
  });

  it("shows placeholders before any turn has produced model data", () => {
    const { lastFrame } = render(
      <TelemetryDock
        telemetry={INITIAL_TELEMETRY_STATE}
        metrics={emptyMetrics()}
        cacheHit={0}
        isStreaming={false}
        now={0}
        cols={120}
        repo={fixtureRepo({ branch: undefined, prNumber: undefined })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("idle");
    expect(frame.match(/—/g)?.length ?? 0).toBeGreaterThanOrEqual(3); // planner/worker/judge placeholders
    expect(frame).toContain("—"); // REPO branch placeholder (no branch)
    expect(frame).toContain("…"); // REPO PR placeholder (still resolving)
  });

  it("REPO panel shows 'no PR' once the async gh lookup resolves to none", () => {
    const { lastFrame } = render(
      <TelemetryDock
        telemetry={INITIAL_TELEMETRY_STATE}
        metrics={emptyMetrics()}
        cacheHit={0}
        isStreaming={false}
        now={0}
        cols={120}
        repo={fixtureRepo({ prNumber: null })}
      />,
    );
    expect(lastFrame() ?? "").toContain("no PR");
  });

  it("REPO panel truncates a long worktree path to its most useful (trailing) segment", () => {
    // cols=100 — matching ink-testing-library's own hardcoded terminal width
    // (see its source), the only value where the `cols` prop and Ink's
    // ACTUAL rendered width agree. Anything wider just gets silently
    // re-shrunk by Ink on top of this component's own truncation (a second,
    // unaccounted-for clip that broke this test's first attempt at cols=140)
    // — exactly the same trap the model-slug width tests above already
    // learned to avoid.
    const { lastFrame } = render(
      <TelemetryDock
        telemetry={INITIAL_TELEMETRY_STATE}
        metrics={emptyMetrics()}
        cacheHit={0}
        isStreaming={false}
        now={0}
        cols={100}
        repo={fixtureRepo({ root: "/Users/mac/Workspaces/some/deeply/nested/path/oxagen-repl2" })}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("/Users/mac/Workspaces/some/deeply/nested/path/oxagen-repl2");
    expect(frame).toContain("…");
    expect(frame).toContain("oxagen-repl2"); // the informative tail survives truncation
  });
});

describe("dockPanelWidth", () => {
  const PANELS = 5;
  const GAPS = PANELS - 1; // 1-col gap between panels

  it("never lets the dock overflow the terminal (regression: 16-col floor clipped the REPO panel's right border at 80 cols)", () => {
    // 24 = the narrowest terminal where the 4-col floor itself still fits;
    // below that the floor necessarily overflows and Ink clips — irrelevant,
    // fullscreen at <24 cols is unusable anyway.
    for (let cols = 24; cols <= 240; cols++) {
      const width = dockPanelWidth(cols);
      expect(width * PANELS + GAPS).toBeLessThanOrEqual(cols);
    }
  });

  it("uses the available width at a default 80-col terminal (15-col panels, 79 total)", () => {
    expect(dockPanelWidth(80)).toBe(15);
  });

  it("keeps a border-capable floor on absurdly narrow screens", () => {
    expect(dockPanelWidth(10)).toBe(4);
  });
});
