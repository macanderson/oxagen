// @vitest-environment jsdom
/**
 * tool-call-card-render.test.tsx
 *
 * Render + interaction tests for the ToolCallCard detail body:
 *   - Shows a human-readable label (never the raw dotted capability)
 *   - Shows the raw capability only in the expanded body + title attr
 *   - Never renders a risk badge (the calm, minimal redesign)
 *   - A failed call reads as a muted "failed", never destructive-red, in the row
 *   - Shows/hides detail panel on toggle; hideHeader renders the body directly
 *   - Renders input/result trees, output stream, and error section
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolCallCard } from "./tool-call-card";

afterEach(cleanup);

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    ChevronDown: vi.fn(() => <span data-testid="chevron-down" />),
    ChevronRight: vi.fn(() => <span data-testid="chevron-right" />),
  };
});

describe("ToolCallCard", () => {
  const baseProps = {
    toolCallId: "tc-1",
    capability: "search_web",
    inputPreview: { query: "hello" },
    riskLevel: "low" as const,
    status: "completed" as const,
    durationMs: 1500,
  };

  it("renders the human-readable label instead of the raw capability", () => {
    render(<ToolCallCard {...baseProps} />);
    expect(screen.getByText("Search the web")).toBeInTheDocument();
    // The raw dotted string never appears in the collapsed row.
    expect(screen.queryByText("search_web")).not.toBeInTheDocument();
  });

  it("derives a label for uncurated capabilities", () => {
    render(<ToolCallCard {...baseProps} capability="query_ontology" />);
    expect(screen.getByText("Query knowledge graph")).toBeInTheDocument();
    expect(screen.queryByText("query_ontology")).not.toBeInTheDocument();
  });

  it("exposes the raw capability as the header button title", () => {
    render(<ToolCallCard {...baseProps} />);
    const toggle = screen.getByRole("button", { name: /tool call details/i });
    expect(toggle).toHaveAttribute("title", "search_web");
  });

  it("shows the raw capability inside the expanded body", async () => {
    render(<ToolCallCard {...baseProps} />);
    await userEvent.click(
      screen.getByRole("button", { name: /tool call details/i }),
    );
    expect(screen.getByText("search_web")).toBeInTheDocument();
  });

  it("never renders a risk badge, even for elevated risk", () => {
    const { rerender } = render(
      <ToolCallCard {...baseProps} riskLevel="low" />,
    );
    expect(screen.queryByText(/^(low|medium|high)$/i)).not.toBeInTheDocument();
    rerender(<ToolCallCard {...baseProps} riskLevel="high" />);
    expect(screen.queryByText(/^(low|medium|high)$/i)).not.toBeInTheDocument();
  });

  it("shows a muted 'failed' indicator (not destructive-red label) when the call failed", () => {
    render(<ToolCallCard {...baseProps} status="failed" />);
    const label = screen.getByText("Search the web");
    expect(label.className).not.toContain("text-destructive");
    // The failure reads as a quiet muted word.
    const failed = screen.getByLabelText("Failed");
    expect(failed).toHaveTextContent("failed");
    expect(failed.className).toContain("text-muted-foreground");
  });

  it("shows a muted completed check", () => {
    render(<ToolCallCard {...baseProps} status="completed" />);
    expect(screen.getByLabelText("Completed")).toBeInTheDocument();
  });

  it("shows duration when not running", () => {
    render(
      <ToolCallCard {...baseProps} status="completed" durationMs={2000} />,
    );
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
    const toggle = screen.getByRole("button", { name: /tool call details/i });
    await userEvent.click(toggle);
    expect(screen.getByText("Input")).toBeInTheDocument();
  });

  it("renders an object input preview as a typed key/value tree, not raw JSON", async () => {
    const { container } = render(
      <ToolCallCard {...baseProps} inputPreview={{ query: "hello" }} />,
    );
    const toggle = screen.getByRole("button", { name: /tool call details/i });
    await userEvent.click(toggle);
    // Humanized label + value, never the quoted JSON key.
    expect(screen.getByText("Query")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(container.textContent ?? "").not.toContain('"query"');
    expect(container.textContent ?? "").not.toContain("{");
  });

  it("shows the composing state (not raw partial JSON) while args stream in", async () => {
    render(
      <ToolCallCard
        {...baseProps}
        inputPreview='{"partial":'
        status="pending"
      />,
    );
    const toggle = screen.getByRole("button", { name: /tool call details/i });
    await userEvent.click(toggle);
    // The unparsed partial must NOT be rendered; a clean composing indicator is.
    expect(screen.getByText("Composing arguments…")).toBeInTheDocument();
    expect(screen.queryByText('{"partial":')).not.toBeInTheDocument();
  });

  it("shows 'Composing arguments…' when inputPreview is empty string and status pending", async () => {
    render(<ToolCallCard {...baseProps} inputPreview="" status="pending" />);
    const toggle = screen.getByRole("button", { name: /tool call details/i });
    await userEvent.click(toggle);
    expect(screen.getByText("Composing arguments…")).toBeInTheDocument();
  });

  it("renders the result section as a typed tree when completed with output", async () => {
    render(
      <ToolCallCard
        {...baseProps}
        status="completed"
        output={{ matchCount: 7 }}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /tool call details/i }),
    );
    expect(screen.getByText("Result")).toBeInTheDocument(); // section label
    expect(screen.getByText("Match count")).toBeInTheDocument(); // humanized key
    expect(screen.getByText("7")).toBeInTheDocument(); // value
  });

  it("renders error section when failed with errorReason", async () => {
    render(
      <ToolCallCard
        {...baseProps}
        status="failed"
        errorReason="Connection refused"
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /tool call details/i }),
    );
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
  });

  it("renders stdout in output stream section", async () => {
    render(
      <ToolCallCard {...baseProps} status="completed" stdout="Hello stdout" />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /tool call details/i }),
    );
    expect(screen.getByText("Hello stdout")).toBeInTheDocument();
  });

  it("renders stderr in output stream section", async () => {
    render(
      <ToolCallCard {...baseProps} status="completed" stderr="Error output" />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /tool call details/i }),
    );
    expect(screen.getByText("Error output")).toBeInTheDocument();
  });

  it("defaultOpen=true opens the panel immediately", () => {
    render(<ToolCallCard {...baseProps} defaultOpen />);
    expect(screen.getByText("Input")).toBeInTheDocument();
  });

  it("toggles closed when clicking the toggle button while open", async () => {
    render(<ToolCallCard {...baseProps} defaultOpen />);
    expect(screen.getByText("Input")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /tool call details/i }),
    );
    expect(screen.queryByText("Input")).not.toBeInTheDocument();
  });

  it("hideHeader renders the body directly with no toggle button, keeping the test id", () => {
    const { container } = render(<ToolCallCard {...baseProps} hideHeader />);
    // No collapsible header button.
    expect(
      screen.queryByRole("button", { name: /tool call details/i }),
    ).not.toBeInTheDocument();
    // Body is shown immediately.
    expect(screen.getByText("Input")).toBeInTheDocument();
    // e2e continuity: the card keeps its test id.
    expect(
      container.querySelector('[data-testid="tool-call-card-tc-1"]'),
    ).toBeInTheDocument();
  });

  it("labels the input section and shows the composing indicator when pending", async () => {
    render(
      <ToolCallCard
        {...baseProps}
        status="pending"
        inputPreview={{ key: "val" }}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /tool call details/i }),
    );
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("Composing arguments…")).toBeInTheDocument();
  });

  it("sets data-capability and data-status attributes", () => {
    const { container } = render(<ToolCallCard {...baseProps} />);
    const root = container.querySelector("[data-component='tool-call-card']");
    expect(root).toHaveAttribute("data-capability", "search_web");
    expect(root).toHaveAttribute("data-status", "completed");
  });
});
