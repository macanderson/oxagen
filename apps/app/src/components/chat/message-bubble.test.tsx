// @vitest-environment jsdom
/**
 * message-bubble.test.tsx
 *
 * Render tests for MessageBubble:
 *   - Renders user message (right-aligned)
 *   - Renders assistant message (left-aligned)
 *   - Renders role label
 *   - Renders plain text content when no contentBlocks
 *   - Renders branch reason badge when set
 *   - Renders content blocks in timeline mode when multiple blocks
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant: _variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-testid="badge">{children}</span>
  ),
}));

// Mock all the card components
vi.mock("./tool-call-card", () => ({
  ToolCallCard: () => <div data-testid="tool-call-card" />,
}));

vi.mock("./approval-card", () => ({
  ApprovalCard: () => <div data-testid="approval-card" />,
}));

vi.mock("./plan-card", () => ({
  PlanCard: () => <div data-testid="plan-card" />,
}));

vi.mock("./subagent-fanout", () => ({
  SubagentFanout: () => <div data-testid="subagent-fanout" />,
}));

vi.mock("./memory-card", () => ({
  MemoryCard: () => <div data-testid="memory-card" />,
}));

vi.mock("./code-execute-card", () => ({
  CodeExecuteCard: () => <div data-testid="code-execute-card" />,
}));

vi.mock("./reasoning-card", () => ({
  ReasoningCard: () => <div data-testid="reasoning-card" />,
}));

vi.mock("./activity-timeline", () => ({
  ActivityTimeline: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="activity-timeline">{children}</div>
  ),
  TimelineItem: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="timeline-item">{children}</div>
  ),
}));

vi.mock("./chat-component-registry", () => ({
  CHAT_COMPONENTS: {},
  logUnknownComponent: vi.fn(),
  UnknownComponentCard: ({ componentId }: { componentId: string }) => (
    <div data-testid="unknown-component-card">{componentId}</div>
  ),
}));

vi.mock("./markdown-message", () => ({
  MarkdownMessage: ({ children }: { children: string }) => (
    <div data-testid="markdown-message">{children}</div>
  ),
}));

describe("MessageBubble", () => {
  const baseMessage = {
    publicId: "msg_1",
    role: "user" as const,
    content: "Hello world",
    branchReason: null,
    siblingCount: 1,
  };

  it("renders user role label", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(<MessageBubble message={baseMessage} />);
    expect(screen.getByText("user")).toBeInTheDocument();
  });

  it("renders assistant role label", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(<MessageBubble message={{ ...baseMessage, role: "assistant" }} />);
    expect(screen.getByText("assistant")).toBeInTheDocument();
  });

  it("renders plain text content via MarkdownMessage", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(<MessageBubble message={baseMessage} />);
    expect(screen.getByTestId("markdown-message")).toHaveTextContent("Hello world");
  });

  it("renders branchReason badge when present", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble message={{ ...baseMessage, branchReason: "retry" }} />,
    );
    expect(screen.getByTestId("badge")).toHaveTextContent("retry");
  });

  it("does not render badge when branchReason is null", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(<MessageBubble message={baseMessage} />);
    expect(screen.queryByTestId("badge")).not.toBeInTheDocument();
  });

  it("renders single text block without ActivityTimeline", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          role: "assistant",
          contentBlocks: [{ type: "text", text: "Solo text" }],
        }}
      />,
    );
    // Single text block → no timeline
    expect(screen.queryByTestId("activity-timeline")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown-message")).toHaveTextContent("Solo text");
  });

  it("renders ActivityTimeline when multiple content blocks present", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          role: "assistant",
          contentBlocks: [
            { type: "reasoning", reasoningId: "r1", text: "thinking…" },
            { type: "text", text: "answer" },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("activity-timeline")).toBeInTheDocument();
  });

  it("renders the UnknownComponentCard fallback for an unregistered componentId", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          role: "assistant",
          contentBlocks: [
            { type: "text", text: "Here you go" },
            {
              type: "component",
              toolCallId: "tc_unknown_1",
              componentId: "not-a-registered-component",
              props: {},
            },
          ],
        }}
      />,
    );
    // The unknown componentId renders a visible fallback, never a silent gap.
    expect(screen.getByTestId("unknown-component-card")).toHaveTextContent(
      "not-a-registered-component",
    );
  });

  it("renders children when passed", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble message={baseMessage}>
        <div data-testid="child-slot">branch nav</div>
      </MessageBubble>,
    );
    expect(screen.getByTestId("child-slot")).toBeInTheDocument();
  });
});
