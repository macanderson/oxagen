// @vitest-environment jsdom
/**
 * code-execute-card-render.test.tsx
 *
 * Render + interaction tests for CodeExecuteCard:
 *   - COLLAPSED by default: code and output are tool I/O and never render
 *     expanded in the conversation; the header row is the only default UI
 *   - Clicking the header expands the detail body; defaultOpen opens it
 *   - Renders the human-readable "Run code" header label + language
 *   - Renders the quiet header status glyph for the current status
 *   - Shows "Waiting for output..." in stdout tab when status=running (open)
 *   - Shows the exit code / OOM killed statuses in the open body
 *   - Shows "Preview HTML" button when stdout is HTML and status=completed
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

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

vi.mock("./tool-call-card", () => ({
  formatDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
  safeJson: (v: unknown) => JSON.stringify(v),
  HeaderStatus: ({ status }: { status: string }) => (
    <span data-testid={`status-${status}`} />
  ),
}));

// Mock React.lazy so HtmlArtifact doesn't need real import
vi.mock("@/components/chat/registry-components/artifact-iframe", () => ({
  default: ({ html, title }: { html: string; title: string }) => (
    <div data-testid="html-artifact" data-title={title}>
      {html.slice(0, 20)}
    </div>
  ),
}));

describe("CodeExecuteCard", () => {
  const baseProps = {
    toolCallId: "tc_1",
    language: "python",
    code: "print('hello')",
    status: "completed" as const,
    stdout: "hello\n",
    exitCode: 0,
  };

  it("is collapsed by default: code, output and exit status are hidden", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    expect(screen.queryByText("print('hello')")).not.toBeInTheDocument();
    expect(screen.queryByText(/exit 0/)).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand code run details" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("clicking the header expands the detail body", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Expand code run details" }),
    );
    expect(screen.getByText("print('hello')")).toBeInTheDocument();
    expect(screen.getByText(/exit 0/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Collapse code run details" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("defaultOpen=true renders the body immediately", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} defaultOpen />);
    expect(screen.getByText("print('hello')")).toBeInTheDocument();
  });

  it("renders the human-readable 'Run code' label, not the raw capability", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    expect(screen.getByText("Run code")).toBeInTheDocument();
    expect(screen.queryByText("execute_code")).not.toBeInTheDocument();
  });

  it("exposes the raw capability via data-capability and header title", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    const root = document.querySelector("[data-component='code-execute-card']");
    expect(root).toHaveAttribute("data-capability", "execute_code");
    expect(
      document.querySelector("[title='execute_code']"),
    ).toBeInTheDocument();
  });

  it("renders the language as a plain muted label in the collapsed header", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    const language = screen.getByText("python");
    expect(language).toBeInTheDocument();
    expect(language.className).toContain("text-muted-foreground");
  });

  it("renders code in a pre/code block when open", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} defaultOpen />);
    expect(screen.getByText("print('hello')")).toBeInTheDocument();
  });

  it("renders the quiet header status glyph for the current status", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    expect(screen.getByTestId("status-completed")).toBeInTheDocument();
  });

  it("shows 'Waiting for output...' in stdout tab when running and no stdout", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(
      <CodeExecuteCard
        toolCallId="tc_2"
        language="node"
        code="console.log('hi')"
        status="running"
        defaultOpen
      />,
    );
    expect(screen.getByText("Waiting for output…")).toBeInTheDocument();
  });

  it("shows a success-toned exit code status when status is not running", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} defaultOpen />);
    const status = screen.getByText(/exit 0/);
    expect(status).toBeInTheDocument();
    expect(status.className).toContain("text-success");
  });

  it("shows a destructive-toned OOM killed status when oomKilled=true", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(
      <CodeExecuteCard {...baseProps} oomKilled exitCode={1} defaultOpen />,
    );
    const oom = screen.getByText("OOM killed");
    expect(oom).toBeInTheDocument();
    expect(oom.className).toContain("text-destructive");
  });

  it("does not show the exit code status when running", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(
      <CodeExecuteCard
        toolCallId="tc_3"
        language="python"
        code="print('x')"
        status="running"
        defaultOpen
      />,
    );
    expect(screen.queryByText(/exit /)).not.toBeInTheDocument();
  });

  it("renders duration in the collapsed header when provided and not running", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} durationMs={2500} />);
    expect(screen.getByText("3s")).toBeInTheDocument();
  });

  it("shows 'Preview HTML' button when stdout is HTML and status=completed", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(
      <CodeExecuteCard
        toolCallId="tc_html"
        language="python"
        code="print('<html>...</html>')"
        status="completed"
        exitCode={0}
        stdout="<!DOCTYPE html><html><body>Hello</body></html>"
        defaultOpen
      />,
    );
    expect(
      screen.getByRole("button", { name: "Show HTML preview" }),
    ).toBeInTheDocument();
  });

  it("renders data-component='code-execute-card' attribute", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    expect(
      document.querySelector("[data-component='code-execute-card']"),
    ).toBeInTheDocument();
  });
});
