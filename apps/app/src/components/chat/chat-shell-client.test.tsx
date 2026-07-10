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

// The first `await import("./chat-shell-client")` pulls a heavy module graph;
// under coverage instrumentation on a loaded CI runner it can blow past the
// 5s default, and the timed-out test's stray render then breaks the next one.
vi.setConfig({ testTimeout: 20_000 });

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
    turnError: undefined,
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
// Stub the empty-state gallery: its real import chain (agent-picker-panel →
// motion/react, lucide-react, @oxagen/ui) takes ~19s to load under vitest,
// which pushes the file's first test past the 20s timeout.
vi.mock("./agent-picker/agent-gallery", () => ({
  AgentGallery: () => <div data-testid="agent-gallery" />,
}));
vi.mock("./suggested-prompt-chips", () => ({ SuggestedPromptChips: () => null }));
vi.mock("./coding-trace-panel", () => ({
  CodingTracePanel: () => <div data-testid="coding-trace-panel" />,
}));
vi.mock("./workspace-context-panel", () => ({
  WorkspaceContextPanel: () => <div data-testid="workspace-context-panel" />,
}));
vi.mock("./activity-timeline", () => ({
  ActivityTimeline: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  // Forward `id` so tests can assert the `#turn-entry-<key>` deep-link anchor
  // the coding-trace-panel rail relies on actually lands on the DOM node.
  TimelineItem: ({ children, id }: { children: React.ReactNode; id?: string }) => (
    <div id={id}>{children}</div>
  ),
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
// Mock MessageFooter to avoid pulling in server-only imports from
// message-footer-actions (which uses "use server" / server-only).
vi.mock("./message-footer", () => ({ MessageFooter: () => null }));
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

// ── Toast manager stub ───────────────────────────────────────────────────────
// The component calls useToast() to surface turn-level errors. Stub it so the
// existing render tests don't need a real ToastProvider, and so the turnError
// test can assert what got enqueued.
const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}));

// ── Minimal modelConfig stub ─────────────────────────────────────────────────
const modelConfig = {
  text: { fast: "claude-haiku-4-5", smart: "claude-sonnet-5" },
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
      resolveConsentAction={async () => ({ ok: true })}
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
        resolveConsentAction={async () => ({ ok: true })}
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

// ── Stream error banner ───────────────────────────────────────────────────────
// Tests that a non-2xx SSE response and a mid-stream network error both render
// a visible error banner to the user (data-testid="stream-error-banner").

describe("ChatShellClient — stream error banner on non-2xx SSE response", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderAndSubmit(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
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
          conversationId: "conv-err-test",
          conversationPublicId: "conv_pub_err",
          userMessageId: "msg-err",
        })}
        resolveApprovalAction={async () => ({ ok: true })}
        resolveConsentAction={async () => ({ ok: true })}
        resolvePlanAction={async () => ({ ok: true })}
        orgSlug="test-org"
        workspaceSlug="test-ws"
        modelConfig={modelConfig}
      />,
    );
    const action = capturedComposerProps.action as (fd: FormData) => Promise<unknown>;
    const fd = new FormData();
    fd.set("content", "Hello");
    await action(fd);
    // Allow micro-task queue to flush
    await new Promise((r) => setTimeout(r, 20));
  }

  it("renders stream-error-banner when SSE endpoint returns 500", async () => {
    await renderAndSubmit(async () =>
      new Response(null, { status: 500, statusText: "Internal Server Error" }),
    );
    expect(screen.getByTestId("stream-error-banner")).toBeInTheDocument();
    expect(screen.getByTestId("stream-error-banner")).toHaveTextContent("500");
  });

  it("renders stream-error-banner when SSE endpoint returns 401", async () => {
    await renderAndSubmit(async () =>
      new Response(null, { status: 401, statusText: "Unauthorized" }),
    );
    expect(screen.getByTestId("stream-error-banner")).toBeInTheDocument();
    expect(screen.getByTestId("stream-error-banner")).toHaveTextContent("401");
  });

  it("renders stream-error-banner when SSE endpoint returns 429", async () => {
    await renderAndSubmit(async () =>
      new Response(null, { status: 429, statusText: "Too Many Requests" }),
    );
    expect(screen.getByTestId("stream-error-banner")).toBeInTheDocument();
  });

  it("surfaces the server's JSON error message on a 422 (attachment resolve failure)", async () => {
    const serverMessage =
      "One or more attachments could not be found, belong to another workspace, or are not ready yet. Please remove and re-attach the file, then try again.";
    await renderAndSubmit(async () =>
      new Response(JSON.stringify({ error: serverMessage }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );
    const banner = screen.getByTestId("stream-error-banner");
    expect(banner).toBeInTheDocument();
    // The actionable server message is shown verbatim — NOT a bare "HTTP 422".
    expect(banner).toHaveTextContent(serverMessage);
    expect(banner).not.toHaveTextContent("HTTP 422");
  });

  it("falls back to the status message when a non-2xx body carries no error field", async () => {
    await renderAndSubmit(async () =>
      new Response(JSON.stringify({ notError: "x" }), {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );
    const banner = screen.getByTestId("stream-error-banner");
    expect(banner).toHaveTextContent("422");
    expect(banner).toHaveTextContent("please try again");
  });

  it("renders stream-error-banner when fetch throws a non-abort network error", async () => {
    await renderAndSubmit(async () => {
      throw new Error("ERR_CONNECTION_RESET");
    });
    expect(screen.getByTestId("stream-error-banner")).toBeInTheDocument();
    expect(screen.getByTestId("stream-error-banner")).toHaveTextContent(
      "ERR_CONNECTION_RESET",
    );
  });

  it("does NOT render stream-error-banner on a clean 200 response", async () => {
    await renderAndSubmit(async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      ),
    );
    expect(screen.queryByTestId("stream-error-banner")).not.toBeInTheDocument();
  });

  it("does NOT render stream-error-banner on AbortError (interrupt is expected)", async () => {
    await renderAndSubmit(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    // AbortErrors are expected (user interrupt / unmount) — no banner
    expect(screen.queryByTestId("stream-error-banner")).not.toBeInTheDocument();
  });
});

// ── Embedded mode (floating in-app agent panel) ──────────────────────────────
// The drawer owns its own conversation state instead of an RSC. These tests pin
// the contract that makes the user's prompt persist there:
//   - onConversationCreated is called (and router URL pin is skipped) when a
//     turn creates the conversation;
//   - reloadMessages is called after the turn (replacing router.refresh()).

describe("ChatShellClient — embedded mode (in-app panel)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubCleanStream() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              c.close();
            },
          }),
          { status: 200 },
        ),
      ),
    );
  }

  async function renderEmbeddedAndSubmit(extra: Record<string, unknown>) {
    stubCleanStream();
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
          conversationId: "conv-embed",
          conversationPublicId: "conv_pub_embed",
          userMessageId: "msg-embed",
        })}
        resolveApprovalAction={async () => ({ ok: true })}
        resolveConsentAction={async () => ({ ok: true })}
        resolvePlanAction={async () => ({ ok: true })}
        orgSlug="test-org"
        workspaceSlug="test-ws"
        modelConfig={modelConfig}
        {...extra}
      />,
    );
    const action = capturedComposerProps.action as (fd: FormData) => Promise<unknown>;
    const fd = new FormData();
    fd.set("content", "Recent activity?");
    await action(fd);
    await new Promise((r) => setTimeout(r, 20));
  }

  it("calls onConversationCreated with the new ids and does NOT pin the URL", async () => {
    const onConversationCreated = vi.fn();
    await renderEmbeddedAndSubmit({ onConversationCreated, reloadMessages: vi.fn() });
    expect(onConversationCreated).toHaveBeenCalledWith("conv-embed", "conv_pub_embed");
    // The floating panel has no route to pin — router.replace must not fire.
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("calls reloadMessages after the turn instead of router.refresh()", async () => {
    const reloadMessages = vi.fn();
    await renderEmbeddedAndSubmit({ reloadMessages, onConversationCreated: vi.fn() });
    expect(reloadMessages).toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("mounts the coding-trace-panel + workspace-context-panel rail by default, hides it when showFiles={false}", async () => {
    cleanup();
    await renderClient();
    // Default (showFiles undefined → true) mounts the right rail.
    expect(screen.getByTestId("coding-trace-panel")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-context-panel")).toBeInTheDocument();

    cleanup();
    const { ChatShellClient } = await import("./chat-shell-client");
    render(
      <ChatShellClient
        conversationId={null}
        conversationPublicId={null}
        activeLeafMessageId={null}
        messages={[]}
        sendAction={noop}
        resolveApprovalAction={async () => ({ ok: true })}
        resolveConsentAction={async () => ({ ok: true })}
        resolvePlanAction={async () => ({ ok: true })}
        orgSlug="test-org"
        workspaceSlug="test-ws"
        modelConfig={modelConfig}
        showFiles={false}
      />,
    );
    expect(screen.queryByTestId("coding-trace-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-context-panel")).not.toBeInTheDocument();
  });
});

describe("ChatShellClient — turn-entry deep-link anchors", () => {
  afterEach(() => {
    mockStream.overrides = {};
  });

  it("stamps `#turn-entry-<key>` on each live timeline node for the coding-trace-panel rail to link to", async () => {
    mockStream.overrides = {
      toolCalls: {
        tc1: {
          toolCallId: "tc1",
          messageId: "m1",
          capability: "graph.query",
          inputPreview: {},
          riskLevel: "low",
          status: "completed",
          stdout: "",
          stderr: "",
          startedAt: Date.now(),
        },
      },
      order: ["tool:tc1"],
    };
    await renderClient();
    expect(document.querySelector("#turn-entry-tool\\:tc1")).toBeInTheDocument();
  });

  it("wraps the turn-result footer in a `#turn-result` anchor once turnUsage lands", async () => {
    mockStream.overrides = {
      order: ["text:m1:0"],
      textSegments: { "text:m1:0": { key: "text:m1:0", messageId: "m1", text: "Done." } },
      turnUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
    await renderClient();
    expect(document.querySelector("#turn-result")).toBeInTheDocument();
  });

  it("does not render the `#turn-result` anchor while the turn is still in flight", async () => {
    mockStream.overrides = {
      order: ["text:m1:0"],
      textSegments: { "text:m1:0": { key: "text:m1:0", messageId: "m1", text: "Working…" } },
      turnUsage: undefined,
    };
    await renderClient();
    expect(document.querySelector("#turn-result")).not.toBeInTheDocument();
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

describe("ChatShellClient — turn error surfaces a toast (not inline JSON)", () => {
  beforeEach(() => {
    toastAdd.mockClear();
    mockStream.overrides = {};
  });
  afterEach(() => {
    mockStream.overrides = {};
  });

  it("raises an error toast with a friendly title + message for a billing turnError", async () => {
    mockStream.overrides = {
      turnError: {
        code: "insufficient_credits",
        message: "Insufficient credits: your balance is empty. Please add credits to continue.",
      },
    };
    await renderClient();
    expect(toastAdd).toHaveBeenCalledTimes(1);
    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Insufficient credits",
      description: "Insufficient credits: your balance is empty. Please add credits to continue.",
    });
  });

  it("uses a generic title when the turnError carries no recognized code", async () => {
    mockStream.overrides = { turnError: { message: "Gateway timeout" } };
    await renderClient();
    expect(toastAdd).toHaveBeenCalledTimes(1);
    expect(toastAdd).toHaveBeenCalledWith({
      type: "error",
      title: "Request failed",
      description: "Gateway timeout",
    });
  });

  it("does not toast when there is no turnError", async () => {
    mockStream.overrides = {};
    await renderClient();
    expect(toastAdd).not.toHaveBeenCalled();
  });
});
