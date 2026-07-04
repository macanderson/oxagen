// @vitest-environment jsdom
/**
 * terminal-trace-card.test.tsx
 *
 * Unit tests for the terminal-trace registry component:
 *   1. parseAnsi — pure SGR (color/bold) escape-sequence parser
 *   2. ansiToLines — line-splitting that preserves color state across newlines
 *   3. Render smoke tests — exit-code badge, duration, command, tabs, truncation
 *
 * Registration in CHAT_COMPONENTS is covered by chat-component-registry.test.ts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { parseAnsi, ansiToLines } from "./terminal-trace-card";

afterEach(cleanup);

const ESC = "";

// ── parseAnsi ────────────────────────────────────────────────────────────────

describe("parseAnsi", () => {
  it("returns a single unstyled segment for plain text", () => {
    expect(parseAnsi("hello world")).toEqual([{ text: "hello world", className: "" }]);
  });

  it("applies a foreground color class after an SGR color code", () => {
    const segments = parseAnsi(`${ESC}[31mred text${ESC}[0m`);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("red text");
    expect(segments[0]?.className).toContain("text-red-600");
  });

  it("resets style at code 0", () => {
    const segments = parseAnsi(`${ESC}[32mgreen${ESC}[0mplain`);
    expect(segments[0]?.className).toContain("text-green-600");
    expect(segments[1]?.text).toBe("plain");
    expect(segments[1]?.className).toBe("");
  });

  it("adds font-semibold for bold code 1", () => {
    const segments = parseAnsi(`${ESC}[1mbold${ESC}[0m`);
    expect(segments[0]?.className).toContain("font-semibold");
  });

  it("clears foreground on code 39 (default fg) without touching bold", () => {
    const segments = parseAnsi(`${ESC}[1;31mtext${ESC}[39mmore`);
    expect(segments[0]?.className).toContain("text-red-600");
    expect(segments[1]?.className).not.toContain("text-red-600");
    expect(segments[1]?.className).toContain("font-semibold");
  });

  it("strips unsupported CSI sequences (e.g. cursor movement) with no style change", () => {
    const segments = parseAnsi(`before${ESC}[2Kafter`);
    expect(segments.map((s) => s.text).join("")).toBe("beforeafter");
  });

  it("handles bright foreground colors (90-97)", () => {
    const segments = parseAnsi(`${ESC}[92mbright green${ESC}[0m`);
    expect(segments[0]?.className).toContain("text-green-400");
  });

  it("returns an empty array for an empty string", () => {
    expect(parseAnsi("")).toEqual([]);
  });
});

// ── ansiToLines ──────────────────────────────────────────────────────────────

describe("ansiToLines", () => {
  it("splits plain text into one array per line", () => {
    const lines = ansiToLines("line1\nline2\nline3");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.[0]?.text).toBe("line1");
    expect(lines[2]?.[0]?.text).toBe("line3");
  });

  it("returns a single empty line for an empty string", () => {
    expect(ansiToLines("")).toEqual([[]]);
  });

  it("preserves color state across a line break", () => {
    const lines = ansiToLines(`${ESC}[31mred line one\nred line two${ESC}[0m`);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.[0]?.className).toContain("text-red-600");
    expect(lines[1]?.[0]?.className).toContain("text-red-600");
  });

  it("produces an empty segment array for a blank line between content", () => {
    const lines = ansiToLines("a\n\nb");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toEqual([]);
  });
});

// ── Render smoke tests ────────────────────────────────────────────────────────

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div role="tablist">{children}</div>,
  TabsTab: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button role="tab" data-value={value} type="button">
      {children}
    </button>
  ),
  TabsPanel: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div role="tabpanel" data-value={value}>
      {children}
    </div>
  ),
}));

vi.mock("../tool-call-card", () => ({
  formatDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
}));

describe("TerminalTraceCard", () => {
  it("shows a success exit-code badge for exit 0", async () => {
    const { default: TerminalTraceCard } = await import("./terminal-trace-card");
    render(<TerminalTraceCard stdout="ok" exitCode={0} />);
    expect(screen.getByText("exit 0")).toBeInTheDocument();
  });

  it("shows a destructive exit-code badge for a non-zero exit", async () => {
    const { default: TerminalTraceCard } = await import("./terminal-trace-card");
    render(<TerminalTraceCard stdout="" stderr="boom" exitCode={1} />);
    const badge = screen.getByText("exit 1");
    expect(badge.closest("[data-variant]")).toHaveAttribute("data-variant", "destructive");
  });

  it("omits the exit-code badge when exitCode is undefined", async () => {
    const { default: TerminalTraceCard } = await import("./terminal-trace-card");
    render(<TerminalTraceCard stdout="still running" />);
    expect(screen.queryByText(/exit /)).not.toBeInTheDocument();
  });

  it("renders the formatted duration when provided", async () => {
    const { default: TerminalTraceCard } = await import("./terminal-trace-card");
    render(<TerminalTraceCard stdout="x" durationMs={2500} />);
    expect(screen.getByText("3s")).toBeInTheDocument();
  });

  it("renders the command line when provided", async () => {
    const { default: TerminalTraceCard } = await import("./terminal-trace-card");
    render(<TerminalTraceCard command="pnpm test" stdout="ok" />);
    expect(screen.getByText("$ pnpm test")).toBeInTheDocument();
  });

  it("shows the empty-stdout message when stdout is absent", async () => {
    const { default: TerminalTraceCard } = await import("./terminal-trace-card");
    render(<TerminalTraceCard stderr="oops" />);
    expect(screen.getByText("No stdout.")).toBeInTheDocument();
  });

  it("truncates output beyond 40 lines with a 'Show all' expander", async () => {
    const { default: TerminalTraceCard } = await import("./terminal-trace-card");
    const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    render(<TerminalTraceCard stdout={manyLines} />);
    expect(screen.getByText("line 0")).toBeInTheDocument();
    expect(screen.queryByText("line 49")).not.toBeInTheDocument();
    expect(screen.getByText("Show all 50 lines")).toBeInTheDocument();
  });

  it("expands full output when 'Show all' is clicked", async () => {
    const { default: TerminalTraceCard } = await import("./terminal-trace-card");
    const manyLines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    render(<TerminalTraceCard stdout={manyLines} />);
    screen.getByText("Show all 50 lines").click();
    expect(screen.getByText("line 49")).toBeInTheDocument();
  });

  it("renders data-component='terminal-trace-card' attribute", async () => {
    const { default: TerminalTraceCard } = await import("./terminal-trace-card");
    render(<TerminalTraceCard stdout="ok" />);
    expect(document.querySelector("[data-component='terminal-trace-card']")).toBeInTheDocument();
  });
});
