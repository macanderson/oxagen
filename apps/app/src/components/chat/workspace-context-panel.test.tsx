// @vitest-environment jsdom
/**
 * workspace-context-panel.test.tsx
 *
 * Covers:
 *   - findActiveSandboxSessionId (pure): finds the most recent completed
 *     `agent.sandbox.start` tool call's sessionId; ignores pending/failed
 *     starts and calls with no sessionId in their output.
 *   - WorkspaceContextPanel (render):
 *       - "Files" tab always renders, backed by ConversationFilesList.
 *       - "Workspace" tab is absent until an active sandbox exists.
 *       - Once a sandbox tool call completes, the Workspace tab appears and
 *         the panel auto-switches to it (first appearance only).
 *       - The active tab's `active`/tree props reflect the current tab.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { LiveToolCall } from "./use-tool-stream";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Dumb, non-interactive Tabs mock (mirrors the pattern already used in
// code-execute-card-render.test.tsx): renders every TabsPanel unconditionally
// but stamps the controlled `value` onto the root so tests can assert which
// tab the component's own state considers "active" without needing to
// replicate Base UI's internal tab-selection wiring.
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({
    children,
    value,
    className,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
    className?: string;
  }) => (
    <div data-testid="tabs-root" data-active={value} className={className}>
      {children}
    </div>
  ),
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

vi.mock("./conversation-files", () => ({
  ConversationFilesList: ({
    conversationPublicId,
    active,
  }: {
    conversationPublicId: string | null;
    active: boolean;
  }) => (
    <div
      data-testid="conversation-files-list"
      data-active={active ? "true" : "false"}
    >
      files for {conversationPublicId ?? "none"}
    </div>
  ),
}));

vi.mock("./registry-components/workspace-context-panel", () => ({
  default: ({
    sessionId,
    orgSlug,
    workspaceSlug,
    title,
  }: {
    sessionId: string;
    orgSlug?: string;
    workspaceSlug?: string;
    title?: string;
  }) => (
    <div
      data-testid="sandbox-workspace-tree"
      data-session-id={sessionId}
      data-org-slug={orgSlug}
      data-workspace-slug={workspaceSlug}
    >
      {title}
    </div>
  ),
}));

function makeToolCall(overrides: Partial<LiveToolCall> = {}): LiveToolCall {
  return {
    toolCallId: "tc_1",
    messageId: "m_1",
    capability: "start_sandbox",
    inputPreview: {},
    riskLevel: "low",
    status: "completed",
    stdout: "",
    stderr: "",
    startedAt: 100,
    output: { sessionId: "sbx_abc123" },
    ...overrides,
  };
}

describe("findActiveSandboxSessionId", () => {
  it("returns null when there are no tool calls", async () => {
    const { findActiveSandboxSessionId } = await import(
      "./workspace-context-panel"
    );
    expect(findActiveSandboxSessionId({})).toBeNull();
  });

  it("returns null when agent.sandbox.start is still pending", async () => {
    const { findActiveSandboxSessionId } = await import(
      "./workspace-context-panel"
    );
    const tc = makeToolCall({ status: "running", output: undefined });
    expect(findActiveSandboxSessionId({ tc_1: tc })).toBeNull();
  });

  it("returns null when the completed output has no sessionId", async () => {
    const { findActiveSandboxSessionId } = await import(
      "./workspace-context-panel"
    );
    const tc = makeToolCall({ output: {} });
    expect(findActiveSandboxSessionId({ tc_1: tc })).toBeNull();
  });

  it("returns the sessionId of a completed agent.sandbox.start call", async () => {
    const { findActiveSandboxSessionId } = await import(
      "./workspace-context-panel"
    );
    const tc = makeToolCall();
    expect(findActiveSandboxSessionId({ tc_1: tc })).toBe("sbx_abc123");
  });

  it("ignores unrelated capabilities", async () => {
    const { findActiveSandboxSessionId } = await import(
      "./workspace-context-panel"
    );
    const tc = makeToolCall({ capability: "execute_code" });
    expect(findActiveSandboxSessionId({ tc_1: tc })).toBeNull();
  });

  it("picks the most recently started session when multiple exist", async () => {
    const { findActiveSandboxSessionId } = await import(
      "./workspace-context-panel"
    );
    const earlier = makeToolCall({
      toolCallId: "tc_early",
      startedAt: 100,
      output: { sessionId: "sbx_early" },
    });
    const later = makeToolCall({
      toolCallId: "tc_late",
      startedAt: 200,
      output: { sessionId: "sbx_late" },
    });
    expect(
      findActiveSandboxSessionId({ tc_early: earlier, tc_late: later }),
    ).toBe("sbx_late");
  });
});

describe("WorkspaceContextPanel", () => {
  it("always renders the Files tab via ConversationFilesList", async () => {
    const { WorkspaceContextPanel } = await import("./workspace-context-panel");
    render(
      <WorkspaceContextPanel
        conversationPublicId="conv_abc"
        orgSlug="acme"
        workspaceSlug="main"
        toolCalls={{}}
      />,
    );
    const filesList = screen.getByTestId("conversation-files-list");
    expect(filesList).toBeInTheDocument();
    expect(filesList).toHaveTextContent("files for conv_abc");
    expect(filesList).toHaveAttribute("data-active", "true");
  });

  it("hides the Workspace tab when there is no active sandbox", async () => {
    const { WorkspaceContextPanel } = await import("./workspace-context-panel");
    render(
      <WorkspaceContextPanel
        conversationPublicId="conv_abc"
        orgSlug="acme"
        workspaceSlug="main"
        toolCalls={{}}
      />,
    );
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("sandbox-workspace-tree"),
    ).not.toBeInTheDocument();
  });

  it("shows the Workspace tab and auto-switches to it once a sandbox is active", async () => {
    const { WorkspaceContextPanel } = await import("./workspace-context-panel");
    const toolCalls = { tc_1: makeToolCall() };
    render(
      <WorkspaceContextPanel
        conversationPublicId="conv_abc"
        orgSlug="acme"
        workspaceSlug="main"
        toolCalls={toolCalls}
      />,
    );
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    const tree = screen.getByTestId("sandbox-workspace-tree");
    expect(tree).toHaveAttribute("data-session-id", "sbx_abc123");
    expect(tree).toHaveAttribute("data-org-slug", "acme");
    expect(tree).toHaveAttribute("data-workspace-slug", "main");
    // Auto-switched to the workspace tab on first sandbox appearance.
    expect(screen.getByTestId("tabs-root")).toHaveAttribute(
      "data-active",
      "workspace",
    );
  });

  it("passes conversationPublicId through even when null", async () => {
    const { WorkspaceContextPanel } = await import("./workspace-context-panel");
    render(
      <WorkspaceContextPanel
        conversationPublicId={null}
        orgSlug="acme"
        workspaceSlug="main"
        toolCalls={{}}
      />,
    );
    expect(screen.getByTestId("conversation-files-list")).toHaveTextContent(
      "files for none",
    );
  });
});
