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
  Badge: ({
    children,
    variant: _variant,
  }: {
    children: React.ReactNode;
    variant?: string;
  }) => <span data-testid="badge">{children}</span>,
}));

// Mock all the card components
vi.mock("./tool-call-card", () => ({
  ToolCallCard: () => <div data-testid="tool-call-card" />,
}));

// Consecutive tool-call blocks are merged into one ToolActivityGroup; the mock
// exposes how many calls each group received so we can assert the merging.
vi.mock("./tool-activity-group", () => ({
  ToolActivityGroup: ({ items }: { items: Array<{ toolCallId: string }> }) => (
    <div data-testid="tool-activity-group" data-count={items.length} />
  ),
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
  CHAT_COMPONENTS: {
    "known-component": (props: Record<string, unknown>) => (
      <div data-testid="known-component">{String(props.label ?? "")}</div>
    ),
  },
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

// Mock MessageFooter so message-bubble tests are not affected by server-only
// imports inside message-footer-actions (which uses "use server" / server-only).
vi.mock("./message-footer", () => ({
  MessageFooter: () => <div data-testid="message-footer" />,
}));

vi.mock("./registry-components/image-preview", () => ({
  default: ({ url, alt }: { url?: string; alt: string }) => (
    <div data-testid="image-preview" data-url={url}>
      {alt}
    </div>
  ),
}));

vi.mock("./registry-components/file-attachment", () => ({
  default: ({
    url,
    name,
    kind,
  }: {
    url: string;
    name: string;
    kind: string;
  }) => (
    <div data-testid="file-attachment" data-url={url} data-kind={kind}>
      {name}
    </div>
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
    expect(screen.getByTestId("markdown-message")).toHaveTextContent(
      "Hello world",
    );
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
    expect(screen.getByTestId("markdown-message")).toHaveTextContent(
      "Solo text",
    );
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

  it("renders every persisted block type through its card", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          role: "assistant",
          contentBlocks: [
            { type: "text", text: "intro" },
            {
              type: "reasoning",
              reasoningId: "r1",
              text: "thinking…",
              durationMs: 1200,
            },
            {
              type: "tool-call",
              toolCallId: "tc1",
              capability: "render_agent_ui",
              inputPreview: {},
              riskLevel: "low",
              status: "completed",
            },
            {
              type: "code-execute",
              toolCallId: "tc2",
              language: "node",
              code: "1+1",
              status: "failed",
            },
            {
              type: "approval-request",
              approvalId: "ap1",
              capability: "enable_automation",
              inputPreview: {},
              riskLevel: "high",
              expiresAt: "2026-06-12T00:00:00Z",
              resolution: "approved",
            },
            {
              type: "plan",
              planId: "pl1",
              title: "Plan",
              steps: [],
              status: "pending",
            },
            {
              type: "subagent-fanout",
              fanoutId: "f1",
              parentMessageId: "m1",
              children: [],
              status: "running",
            },
            { type: "memory-recall", queryId: "q1", memories: [] },
            {
              type: "component",
              toolCallId: "tc3",
              componentId: "known-component",
              props: { label: "hello" },
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("activity-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("reasoning-card")).toBeInTheDocument();
    // The lone tool-call block renders as a (single-item) activity group.
    expect(screen.getByTestId("tool-activity-group")).toBeInTheDocument();
    expect(screen.getByTestId("code-execute-card")).toBeInTheDocument();
    expect(screen.getByTestId("approval-card")).toBeInTheDocument();
    expect(screen.getByTestId("plan-card")).toBeInTheDocument();
    expect(screen.getByTestId("subagent-fanout")).toBeInTheDocument();
    expect(screen.getByTestId("memory-card")).toBeInTheDocument();
    // Registered componentId renders the real registry component (lazy path).
    expect(await screen.findByTestId("known-component")).toHaveTextContent(
      "hello",
    );
  });

  it("renders terminal-state variants of status-bearing blocks", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          role: "assistant",
          contentBlocks: [
            {
              type: "tool-call",
              toolCallId: "tc1",
              capability: "x",
              inputPreview: {},
              riskLevel: "medium",
              status: "running",
            },
            {
              type: "code-execute",
              toolCallId: "tc2",
              language: "python",
              code: "pass",
              status: "completed",
            },
            {
              type: "approval-request",
              approvalId: "ap1",
              capability: "y",
              inputPreview: {},
              riskLevel: "low",
              expiresAt: "2026-06-12T00:00:00Z",
            },
            {
              type: "plan",
              planId: "pl1",
              title: "Plan",
              steps: [],
              status: "approved",
            },
            {
              type: "subagent-fanout",
              fanoutId: "f1",
              parentMessageId: "m1",
              children: [],
              status: "completed",
            },
            {
              type: "subagent-fanout",
              fanoutId: "f2",
              parentMessageId: "m1",
              children: [],
              status: "timed_out",
            },
          ],
        }}
      />,
    );
    // All blocks render inside the timeline; each card type appears.
    expect(screen.getByTestId("activity-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("tool-activity-group")).toBeInTheDocument();
    expect(screen.getByTestId("code-execute-card")).toBeInTheDocument();
    expect(screen.getByTestId("approval-card")).toBeInTheDocument();
    expect(screen.getByTestId("plan-card")).toBeInTheDocument();
    expect(screen.getAllByTestId("subagent-fanout")).toHaveLength(2);
  });

  it("merges a run of consecutive tool-call blocks into one activity group", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          role: "assistant",
          contentBlocks: [
            { type: "text", text: "working" },
            {
              type: "tool-call",
              toolCallId: "t1",
              capability: "web.search",
              inputPreview: {},
              riskLevel: "low",
              status: "completed",
            },
            {
              type: "tool-call",
              toolCallId: "t2",
              capability: "web.fetch",
              inputPreview: {},
              riskLevel: "low",
              status: "completed",
            },
            {
              type: "tool-call",
              toolCallId: "t3",
              capability: "graph.search",
              inputPreview: {},
              riskLevel: "low",
              status: "completed",
            },
          ],
        }}
      />,
    );
    // One group holding all three consecutive calls.
    const groups = screen.getAllByTestId("tool-activity-group");
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveAttribute("data-count", "3");
  });

  it("splits tool-call runs around an interleaved non-tool block", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          role: "assistant",
          contentBlocks: [
            {
              type: "tool-call",
              toolCallId: "t1",
              capability: "web.search",
              inputPreview: {},
              riskLevel: "low",
              status: "completed",
            },
            { type: "text", text: "an aside" },
            {
              type: "tool-call",
              toolCallId: "t2",
              capability: "web.fetch",
              inputPreview: {},
              riskLevel: "low",
              status: "completed",
            },
          ],
        }}
      />,
    );
    // Two separate groups, one on each side of the text block.
    const groups = screen.getAllByTestId("tool-activity-group");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveAttribute("data-count", "1");
    expect(groups[1]).toHaveAttribute("data-count", "1");
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

  it("does not render the attachments strip when the message has none", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(<MessageBubble message={baseMessage} />);
    expect(screen.queryByTestId("message-attachments")).not.toBeInTheDocument();
  });

  it("renders an image attachment via ImagePreview, served through /api/v1/assets", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          attachments: [
            {
              publicId: "gen_abc",
              kind: "image",
              name: "screenshot.png",
              mimeType: "image/png",
              url: "/api/v1/assets/gen_abc",
            },
          ],
        }}
      />,
    );
    const strip = screen.getByTestId("message-attachments");
    expect(strip).toBeInTheDocument();
    const preview = screen.getByTestId("image-preview");
    expect(preview).toHaveAttribute("data-url", "/api/v1/assets/gen_abc");
    expect(preview).toHaveTextContent("screenshot.png");
  });

  it("renders a non-image attachment via FileAttachment", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          attachments: [
            {
              publicId: "gen_doc",
              kind: "document",
              name: "spec.pdf",
              mimeType: "application/pdf",
              url: "/api/v1/assets/gen_doc",
            },
          ],
        }}
      />,
    );
    const fileCard = screen.getByTestId("file-attachment");
    expect(fileCard).toHaveAttribute("data-kind", "document");
    expect(fileCard).toHaveTextContent("spec.pdf");
  });

  it("renders multiple attachments in one strip", async () => {
    const { MessageBubble } = await import("./message-bubble");
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          attachments: [
            {
              publicId: "gen_1",
              kind: "image",
              name: "a.png",
              mimeType: "image/png",
              url: "/api/v1/assets/gen_1",
            },
            {
              publicId: "gen_2",
              kind: "image",
              name: "b.png",
              mimeType: "image/png",
              url: "/api/v1/assets/gen_2",
            },
          ],
        }}
      />,
    );
    expect(screen.getAllByTestId("image-preview")).toHaveLength(2);
  });
});
