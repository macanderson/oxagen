// @vitest-environment jsdom
/**
 * terminal-trace-card.test.tsx
 *
 * Covers:
 *   - parseAnsiLine: color/bold SGR codes, reset, non-SGR sequence stripping
 *   - TerminalTraceCard render: exit-code status, timed-out status, duration,
 *     command line, stdout/stderr content, auto-collapse beyond 40 lines
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => (
    <div role="tablist">{children}</div>
  ),
  TabsTab: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => (
    <button role="tab" data-value={value} type="button">
      {children}
    </button>
  ),
  TabsPanel: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => (
    <div role="tabpanel" data-value={value}>
      {children}
    </div>
  ),
}));

vi.mock("../tool-call-card", () => ({
  formatDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
}));

describe("parseAnsiLine", () => {
  it("returns a single plain segment for text with no escape codes", async () => {
    const { parseAnsiLine } = await import("./terminal-trace-card");
    expect(parseAnsiLine("hello world")).toEqual([
      { text: "hello world", className: undefined },
    ]);
  });

  it("applies a foreground-color class for a basic SGR code", async () => {
    const { parseAnsiLine } = await import("./terminal-trace-card");
    const segments = parseAnsiLine("\x1b[31merror\x1b[0m ok");
    expect(segments[0]).toMatchObject({
      text: "error",
      className: "text-error",
    });
    expect(segments[1]).toMatchObject({ text: " ok", className: undefined });
  });

  it("resets style on code 0", async () => {
    const { parseAnsiLine } = await import("./terminal-trace-card");
    const segments = parseAnsiLine("\x1b[32mgreen\x1b[0mplain");
    expect(segments[1]?.className).toBeUndefined();
  });

  it("drops non-SGR escape sequences without leaving raw bytes", async () => {
    const { parseAnsiLine } = await import("./terminal-trace-card");
    const segments = parseAnsiLine("\x1b[2Kcleared line");
    const joined = segments.map((s) => s.text).join("");
    expect(joined).toBe("cleared line");
  });

  it("applies bold as an additional class alongside color", async () => {
    const { parseAnsiLine } = await import("./terminal-trace-card");
    const segments = parseAnsiLine("\x1b[1;31mbold red\x1b[0m");
    expect(segments[0]?.className).toContain("text-error");
    expect(segments[0]?.className).toContain("font-semibold");
  });

  // Light-mode regression: the black/gray, magenta, cyan and default-foreground
  // codes must map to the theme-aware `ansi-*` classes (code-surface.css), NOT
  // the old dark-only text-neutral-*/text-white/text-cyan-400/text-fuchsia-400
  // which were invisible or mistuned on a GitHub-light background.
  it("maps non-semantic SGR codes to theme-aware ansi-* classes", async () => {
    const { parseAnsiLine } = await import("./terminal-trace-card");
    const cases: Array<[string, string]> = [
      ["\x1b[30mx", "ansi-dim"],
      ["\x1b[90mx", "ansi-dim"],
      ["\x1b[35mx", "ansi-magenta"],
      ["\x1b[95mx", "ansi-magenta"],
      ["\x1b[36mx", "ansi-cyan"],
      ["\x1b[96mx", "ansi-cyan"],
      ["\x1b[37mx", "ansi-fg"],
      ["\x1b[97mx", "ansi-fg"],
    ];
    for (const [input, expected] of cases) {
      expect(parseAnsiLine(input)[0]?.className).toBe(expected);
    }
    // No dark-only Tailwind colour class survives in the map.
    for (const [input] of cases) {
      const cls = parseAnsiLine(input)[0]?.className ?? "";
      expect(cls).not.toMatch(/text-(neutral|white|cyan|fuchsia)/);
    }
  });
});

describe("TerminalTraceCard", () => {
  it("renders the exit code as a success-toned status for exit 0", async () => {
    const { default: TerminalTraceCard } = await import(
      "./terminal-trace-card"
    );
    render(<TerminalTraceCard exitCode={0} stdout="ok" />);
    const status = screen.getByText("exit 0");
    expect(status).toBeInTheDocument();
    expect(status.className).toContain("text-success");
  });

  it("renders a destructive-toned exit code status for a non-zero exit", async () => {
    const { default: TerminalTraceCard } = await import(
      "./terminal-trace-card"
    );
    render(<TerminalTraceCard exitCode={1} stderr="boom" />);
    const status = screen.getByText("exit 1");
    expect(status.className).toContain("text-destructive");
  });

  it("shows a timed-out status when timedOut is true", async () => {
    const { default: TerminalTraceCard } = await import(
      "./terminal-trace-card"
    );
    render(<TerminalTraceCard exitCode={124} timedOut stdout="" />);
    const timedOut = screen.getByText("Timed out");
    expect(timedOut).toBeInTheDocument();
    expect(timedOut.className).toContain("text-destructive");
  });

  it("renders duration when provided", async () => {
    const { default: TerminalTraceCard } = await import(
      "./terminal-trace-card"
    );
    render(<TerminalTraceCard exitCode={0} durationMs={4200} stdout="done" />);
    expect(screen.getByText("4s")).toBeInTheDocument();
  });

  it("renders the command line when provided", async () => {
    const { default: TerminalTraceCard } = await import(
      "./terminal-trace-card"
    );
    render(
      <TerminalTraceCard exitCode={0} command="pnpm build" stdout="done" />,
    );
    expect(screen.getByText("$ pnpm build")).toBeInTheDocument();
  });

  it("renders stdout content", async () => {
    const { default: TerminalTraceCard } = await import(
      "./terminal-trace-card"
    );
    render(<TerminalTraceCard exitCode={0} stdout="line one\nline two" />);
    expect(screen.getByTestId("terminal-trace-stdout")).toHaveTextContent(
      "line one",
    );
    expect(screen.getByTestId("terminal-trace-stdout")).toHaveTextContent(
      "line two",
    );
  });

  it("shows an empty placeholder when stdout/stderr is absent", async () => {
    const { default: TerminalTraceCard } = await import(
      "./terminal-trace-card"
    );
    render(<TerminalTraceCard exitCode={0} />);
    const placeholders = screen.getAllByText("(empty)");
    expect(placeholders.length).toBeGreaterThan(0);
  });

  it("auto-collapses output beyond 40 lines with an expand control", async () => {
    const { default: TerminalTraceCard } = await import(
      "./terminal-trace-card"
    );
    const longOutput = Array.from(
      { length: 60 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    render(<TerminalTraceCard exitCode={0} stdout={longOutput} />);
    expect(screen.getByText("line 1")).toBeInTheDocument();
    expect(screen.queryByText("line 60")).not.toBeInTheDocument();
    expect(screen.getByText("Show 20 more lines")).toBeInTheDocument();
  });

  it("expands to show all lines when the expand control is clicked", async () => {
    const { default: TerminalTraceCard } = await import(
      "./terminal-trace-card"
    );
    const { default: userEvent } = await import("@testing-library/user-event");
    const longOutput = Array.from(
      { length: 60 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    render(<TerminalTraceCard exitCode={0} stdout={longOutput} />);
    await userEvent.click(screen.getByText("Show 20 more lines"));
    expect(screen.getByText("line 60")).toBeInTheDocument();
    expect(screen.getByText("Show fewer lines")).toBeInTheDocument();
  });

  it("renders data-component and data-status attributes", async () => {
    const { default: TerminalTraceCard } = await import(
      "./terminal-trace-card"
    );
    render(<TerminalTraceCard exitCode={1} stdout="x" />);
    expect(
      document.querySelector("[data-component='terminal-trace-card']"),
    ).toHaveAttribute("data-status", "failed");
  });
});
