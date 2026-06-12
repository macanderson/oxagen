// @vitest-environment jsdom
/**
 * chat-shell-client.test.tsx
 *
 * Focused unit tests for the MCP-specific code paths added to ChatShellClient:
 *   - availableMcpServers prop is forwarded to MessageComposer
 *   - activeServerIds extracted from FormData and included in stream request body
 *   - activeServerIds absent from body when FormData field is not set
 *   - activeServerIds absent from body when field is malformed JSON
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as React from "react";
import type { McpServerSummary } from "./mcp-types";

afterEach(cleanup);

// ── Next.js navigation stubs ────────────────────────────────────────────────
const mockReplace = vi.fn();
const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }),
  usePathname: () => "/test-org/test-ws/ask",
}));

// ── Streaming hook stub ──────────────────────────────────────────────────────
// Hoisted mutable overlay so individual tests can inject live-stream state
// (e.g. a streamed component directive) without re-mocking the module.
const mockStream = vi.hoisted(() => ({
  overrides: {} as Record<string, unknown>,
}));
vi.mock("./use-tool-stream", () => ({
  useToolStream: () => ({
    plans: {},
    pendingApprovals: {},
    toolCalls: {},
    reasonings: {},
    steps: {},
    textSegments: {},
    memoryRecalls: {},
    memoryWrites: {},
    activeFanouts: {},
    components: {},
    order: [],
    turnUsage: undefined,
    consume: vi.fn(),
    reset: vi.fn(),
    hasBlockingApproval: false,
    signalApprovalResolved: vi.fn(),
    ...mockStream.overrides,
  }),
}));

// ── Capture MessageComposer props for assertions ─────────────────────────────
let capturedComposerProps: Record<string, unknown> = {};
vi.mock("./message-composer", () => ({
  MessageComposer: (props: Record<string, unknown>) => {
    capturedComposerProps = props;
    return <div data-testid="message-composer" />;
  },
}));

// ── UI/component stubs ───────────────────────────────────────────────────────
vi.mock("./message-tree", () => ({ MessageTree: () => null }));
vi.mock("./suggested-prompt-chips", () => ({ SuggestedPromptChips: () => null }));
vi.mock("./conversation-files", () => ({ ConversationFiles: () => null }));
vi.mock("./activity-timeline", () => ({
  ActivityTimeline: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TimelineItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./chat-component-registry", () => ({
  CHAT_COMPONENTS: {},
  logUnknownComponent: vi.fn(),
  UnknownComponentCard: ({ componentId }: { componentId: string }) => (
    <div data-testid="unknown-component-card">{componentId}</div>
  ),
}));
vi.mock("./streaming-text", () => ({
  StreamingText: ({ text }: { text: string }) => <span>{text}</span>,
}));
vi.mock("./reasoning-card", () => ({ ReasoningCard: () => null }));
vi.mock("./plan-card", () => ({ PlanCard: () => null }));
vi.mock("./approval-card", () => ({ ApprovalCard: () => null }));
vi.mock("./tool-call-card", () => ({ ToolCallCard: () => null }));
vi.mock("./code-execute-card", () => ({ CodeExecuteCard: () => null }));
vi.mock("./memory-card", () => ({ MemoryCard: () => null }));
vi.mock("./subagent-fanout", () => ({ SubagentFanout: () => null }));
vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));
vi.mock("@/lib/use-latest-ref", () => ({
  useLatestRef: <T,>(val: T) => {
    const ref = React.useRef(val);
    ref.current = val;
    return ref;
  },
}));

// ── Minimal modelConfig stub ─────────────────────────────────────────────────
const modelConfig = {
  text: { fast: "claude-haiku-4-5", smart: "claude-sonnet-4-6" },
  image: { basic: "gpt-image-1" },
  video: { basic: "veo-3.0" },
} as unknown as import("@oxagen/ai/catalog").ResolvedTierCatalog;

// ── Test helpers ─────────────────────────────────────────────────────────────

const noop = async () => ({ ok: true as const });

function makeServer(overrides?: Partial<McpServerSummary>): McpServerSummary {
  return {
    publicId: "mcs_test1",
    name: "Test Server",
    toolCount: 3,
    healthStatus: "healthy",
    ...overrides,
  };
}

async function renderClient(props: Partial<{
  availableMcpServers: McpServerSummary[];
}> = {}) {
  const { ChatShellClient } = await import("./chat-shell-client");
  return render(
    <ChatShellClient
      conversationId={null}
      conversationPublicId={null}
      activeLeafMessageId={null}
      messages={[]}
      sendAction={noop}
      resolveApprovalAction={async () => ({ ok: true })}
      resolvePlanAction={async () => ({ ok: true })}
      orgSlug="test-org"
      workspaceSlug="test-ws"
      modelConfig={modelConfig}
      {...props}
    />,
  );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ChatShellClient — availableMcpServers prop forwarding", () => {
  beforeEach(() => { capturedComposerProps = {}; });

  it("passes undefined availableMcpServers to MessageComposer when not provided", async () => {
    await renderClient();
    expect(screen.getByTestId("message-composer")).toBeInTheDocument();
    expect(capturedComposerProps.availableMcpServers).toBeUndefined();
  });

  it("passes availableMcpServers to MessageComposer when provided", async () => {
    const servers = [makeServer()];
    await renderClient({ availableMcpServers: servers });
    expect(screen.getByTestId("message-composer")).toBeInTheDocument();
    expect(capturedComposerProps.availableMcpServers).toEqual(servers);
  });

  it("passes multiple servers to MessageComposer", async () => {
    const servers = [
      makeServer({ publicId: "mcs_a", name: "Server A" }),
      makeServer({ publicId: "mcs_b", name: "Server B" }),
    ];
    await renderClient({ availableMcpServers: servers });
    expect(capturedComposerProps.availableMcpServers).toHaveLength(2);
    expect(capturedComposerProps.availableMcpServers).toEqual(servers);
  });

  it("passes empty array to MessageComposer when provided", async () => {
    await renderClient({ availableMcpServers: [] });
    expect(capturedComposerProps.availableMcpServers).toEqual([]);
  });
});

describe("ChatShellClient — activeServerIds in stream request body", () => {
  let capturedFetchBody: Record<string, unknown> | null = null;

  beforeEach(() => {
    capturedFetchBody = null;
    capturedComposerProps = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as string;
      capturedFetchBody = JSON.parse(body) as Record<string, unknown>;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function submitWithFormData(fd: FormData) {
    await renderClient();
    // Retrieve the action prop captured on MessageComposer and call it.
    const action = capturedComposerProps.action as (fd: FormData) => Promise<unknown>;
    // Simulate sendAction returning a conversationId so streaming begins.
    const { ChatShellClient: _mod, ..._ } = await import("./chat-shell-client").catch(() => ({ ChatShellClient: null }));
    void _mod; // suppress unused
    // Call wrappedSendAction directly via the captured action prop.
    // We need sendAction to return a conversationId to trigger the fetch.
    // Re-render with a sendAction that returns a conversationId.
    cleanup();
    capturedComposerProps = {};
    const { ChatShellClient } = await import("./chat-shell-client");
    render(
      <ChatShellClient
        conversationId={null}
        conversationPublicId={null}
        activeLeafMessageId={null}
        messages={[]}
        sendAction={async () => ({
          ok: true,
          conversationId: "conv-123",
          conversationPublicId: "conv_pub_123",
          userMessageId: "msg-456",
        })}
        resolveApprovalAction={async () => ({ ok: true })}
        resolvePlanAction={async () => ({ ok: true })}
        orgSlug="test-org"
        workspaceSlug="test-ws"
        modelConfig={modelConfig}
      />,
    );
    const action2 = capturedComposerProps.action as (fd: FormData) => Promise<unknown>;
    await action2(fd);
    // Give async fetch a tick to complete.
    await new Promise((r) => setTimeout(r, 10));
  }

  it("includes activeServerIds in body when FormData field is set", async () => {
    const fd = new FormData();
    fd.set("content", "Hello");
    fd.set("activeServerIds", JSON.stringify(["mcs_test1", "mcs_test2"]));
    await submitWithFormData(fd);
    expect(capturedFetchBody).not.toBeNull();
    expect(capturedFetchBody!.activeServerIds).toEqual(["mcs_test1", "mcs_test2"]);
  });

  it("sends empty array when activeServerIds field is absent", async () => {
    const fd = new FormData();
    fd.set("content", "Hello");
    await submitWithFormData(fd);
    expect(capturedFetchBody).not.toBeNull();
    expect(capturedFetchBody!.activeServerIds).toEqual([]);
  });

  it("sends empty array when activeServerIds field is malformed JSON", async () => {
    const fd = new FormData();
    fd.set("content", "Hello");
    fd.set("activeServerIds", "not-valid-json{{");
    await submitWithFormData(fd);
    expect(capturedFetchBody).not.toBeNull();
    expect(capturedFetchBody!.activeServerIds).toEqual([]);
  });
});

describe("ChatShellClient — live-timeline unknown componentId fallback", () => {
  afterEach(() => {
    mockStream.overrides = {};
  });

  it("renders UnknownComponentCard for a streamed component with an unregistered componentId", async () => {
    mockStream.overrides = {
      components: {
        tc_unknown_live: {
          toolCallId: "tc_unknown_live",
          componentId: "bogus-live-component",
          props: {},
        },
      },
      order: ["component:tc_unknown_live"],
    };
    await renderClient();
    // The live timeline shows a visible fallback, never a silent empty entry.
    expect(screen.getByTestId("unknown-component-card")).toHaveTextContent(
      "bogus-live-component",
    );
  });
});
