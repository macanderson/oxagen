// @vitest-environment jsdom
/**
 * code-execute-card-render.test.tsx
 *
 * Render + interaction tests for CodeExecuteCard:
 *   - Renders the human-readable "Run code" header label
 *   - Renders language badge
 *   - Renders code content in a pre block
 *   - Renders status icon
 *   - Shows "Waiting for output..." in stdout tab when status=running
 *   - Shows exit code badge when not running
 *   - Shows OOM killed badge when oomKilled=true
 *   - Shows "Preview HTML" button when stdout is HTML and status=completed
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant,
  }: {
    children: React.ReactNode;
    variant?: string;
  }) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div role="tablist">{children}</div>,
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
  }) => <div role="tabpanel" data-value={value}>{children}</div>,
}));

vi.mock("./status-icon", () => ({
  StatusIcon: ({ status }: { status: string }) => (
    <span data-testid={`status-${status}`} />
  ),
}));

vi.mock("./tool-call-card", () => ({
  formatDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
  safeJson: (v: unknown) => JSON.stringify(v),
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

  it("renders the human-readable 'Run code' label, not the raw capability", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    expect(screen.getByText("Run code")).toBeInTheDocument();
    expect(screen.queryByText("agent.code.execute")).not.toBeInTheDocument();
  });

  it("exposes the raw capability via data-capability and header title", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    const root = document.querySelector("[data-component='code-execute-card']");
    expect(root).toHaveAttribute("data-capability", "agent.code.execute");
    expect(document.querySelector("[title='agent.code.execute']")).toBeInTheDocument();
  });

  it("renders language badge", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    expect(screen.getByText("python")).toBeInTheDocument();
  });

  it("renders code in a pre/code block", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    expect(screen.getByText("print('hello')")).toBeInTheDocument();
  });

  it("renders status icon for the current status", async () => {
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
      />,
    );
    expect(screen.getByText("Waiting for output…")).toBeInTheDocument();
  });

  it("shows exit code badge when status is not running", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    expect(screen.getByText(/exit 0/)).toBeInTheDocument();
  });

  it("shows OOM killed badge when oomKilled=true", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} oomKilled exitCode={1} />);
    expect(screen.getByText("OOM killed")).toBeInTheDocument();
  });

  it("does not show exit code badge when running", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(
      <CodeExecuteCard
        toolCallId="tc_3"
        language="python"
        code="print('x')"
        status="running"
      />,
    );
    expect(screen.queryByText(/exit /)).not.toBeInTheDocument();
  });

  it("renders duration when provided and status is not running", async () => {
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
      />,
    );
    expect(screen.getByRole("button", { name: "Show HTML preview" })).toBeInTheDocument();
  });

  it("renders data-component='code-execute-card' attribute", async () => {
    const { CodeExecuteCard } = await import("./code-execute-card");
    render(<CodeExecuteCard {...baseProps} />);
    expect(
      document.querySelector("[data-component='code-execute-card']"),
    ).toBeInTheDocument();
  });
});
