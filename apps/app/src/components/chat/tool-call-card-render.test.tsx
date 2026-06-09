// @vitest-environment jsdom
/**
 * tool-call-card-render.test.tsx
 *
 * Render + interaction tests for the ToolCallCard component:
 *   - Shows capability badge
 *   - Shows/hides detail panel on toggle
 *   - Renders input preview in detail panel
 *   - Shows output when completed
 *   - Shows error reason when failed
 *   - Shows stdout / stderr in output stream section
 *   - Shows duration when not running
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolCallCard } from "./tool-call-card";

afterEach(cleanup);

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-testid="badge" data-variant={variant}>{children}</span>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    ChevronDown: vi.fn(() => <span data-testid="chevron-down" />),
    ChevronRight: vi.fn(() => <span data-testid="chevron-right" />),
  };
});

vi.mock("./risk-badge", () => ({
  RiskBadge: ({ risk }: { risk: string }) => <span data-testid="risk-badge">{risk}</span>,
}));

vi.mock("./status-icon", () => ({
  StatusIcon: ({ status }: { status: string }) => (
    <span data-testid="status-icon" data-status={status} />
  ),
}));

describe("ToolCallCard", () => {
  const baseProps = {
    toolCallId: "tc-1",
    capability: "search.web",
    inputPreview: { query: "hello" },
    riskLevel: "low" as const,
    status: "completed" as const,
    durationMs: 1500,
  };

  it("renders the capability badge", () => {
    render(<ToolCallCard {...baseProps} />);
    expect(screen.getByText("search.web")).toBeInTheDocument();
  });

  it("renders the risk badge", () => {
    render(<ToolCallCard {...baseProps} />);
    expect(screen.getByTestId("risk-badge")).toHaveTextContent("low");
  });

  it("renders status icon with correct status", () => {
    render(<ToolCallCard {...baseProps} />);
    expect(screen.getByTestId("status-icon")).toHaveAttribute("data-status", "completed");
  });

  it("shows duration when not running", () => {
    render(<ToolCallCard {...baseProps} status="completed" durationMs={2000} />);
    expect(screen.getByText("2.0s")).toBeInTheDocument();
  });

  it("hides duration when status is running", () => {
    render(<ToolCallCard {...baseProps} status="running" durationMs={500} />);
    expect(screen.queryByText("500ms")).not.toBeInTheDocument();
  });

  it("is collapsed by default (detail panel not shown)", () => {
    render(<ToolCallCard {...baseProps} />);
    // Input label should not be visible when collapsed
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
  });

  it("shows detail panel after clicking the toggle button", async () => {
    render(<ToolCallCard {...baseProps} />);
    const toggle = screen.getByRole("button");
    await userEvent.click(toggle);
    expect(screen.getByText("Input")).toBeInTheDocument();
  });

  it("renders input preview in JSON when it is an object", async () => {
    render(<ToolCallCard {...baseProps} inputPreview={{ query: "hello" }} />);
    const toggle = screen.getByRole("button");
    await userEvent.click(toggle);
    expect(screen.getByText(/"query"/)).toBeInTheDocument();
  });

  it("renders raw string input preview when inputPreview is a string", async () => {
    render(<ToolCallCard {...baseProps} inputPreview='{"partial":' status="pending" />);
    const toggle = screen.getByRole("button");
    await userEvent.click(toggle);
    // The partial string should be present
    expect(screen.getByText('{"partial":')).toBeInTheDocument();
  });

  it("shows 'Composing arguments…' when inputPreview is empty string and status pending", async () => {
    render(<ToolCallCard {...baseProps} inputPreview="" status="pending" />);
    const toggle = screen.getByRole("button");
    await userEvent.click(toggle);
    expect(screen.getByText("Composing arguments…")).toBeInTheDocument();
  });

  it("renders output section when completed with output", async () => {
    render(
      <ToolCallCard {...baseProps} status="completed" output={{ result: "found" }} />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Result")).toBeInTheDocument();
  });

  it("renders error section when failed with errorReason", async () => {
    render(
      <ToolCallCard
        {...baseProps}
        status="failed"
        errorReason="Connection refused"
      />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
  });

  it("renders stdout in output stream section", async () => {
    render(
      <ToolCallCard {...baseProps} status="completed" stdout="Hello stdout" />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Hello stdout")).toBeInTheDocument();
  });

  it("renders stderr in output stream section", async () => {
    render(
      <ToolCallCard {...baseProps} status="completed" stderr="Error output" />,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Error output")).toBeInTheDocument();
  });

  it("defaultOpen=true opens the panel immediately", () => {
    render(<ToolCallCard {...baseProps} defaultOpen />);
    expect(screen.getByText("Input")).toBeInTheDocument();
  });

  it("toggles closed when clicking the toggle button while open", async () => {
    render(<ToolCallCard {...baseProps} defaultOpen />);
    expect(screen.getByText("Input")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
  });

  it("shows 'Composing input…' label when pending", async () => {
    render(<ToolCallCard {...baseProps} status="pending" inputPreview={{ key: "val" }} />);
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByText("Composing input…")).toBeInTheDocument();
  });

  it("sets data-capability and data-status attributes", () => {
    const { container } = render(<ToolCallCard {...baseProps} />);
    const root = container.querySelector("[data-component='tool-call-card']");
    expect(root).toHaveAttribute("data-capability", "search.web");
    expect(root).toHaveAttribute("data-status", "completed");
  });
});
