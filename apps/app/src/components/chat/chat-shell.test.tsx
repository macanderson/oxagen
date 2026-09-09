// @vitest-environment jsdom
/**
 * chat-shell.test.tsx
 *
 * Unit tests for the ChatShell RSC wrapper:
 *   1. Shows MessagesSkeleton fallback while promise is pending
 *   2. After promise resolves, ChatShellClient receives correct props
 *   3. Works with null conversationId
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { ChatShell } from "./chat-shell";
import type { ChatShellProps } from "./chat-shell";

afterEach(cleanup);

// ── module mocks ──────────────────────────────────────────────────────────────

// AsyncShell resolves the chat_ux_v2 cookie via next/headers — outside a real
// request scope cookies() never resolves, so stub it to "no cookie set" by
// default; individual tests set `mockCookieJar` to simulate the chat_ux_v2
// override cookie.
const { mockCookieJar } = vi.hoisted(() => ({
  mockCookieJar: { value: undefined as string | undefined },
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "chat_ux_v2" && mockCookieJar.value !== undefined
        ? { name, value: mockCookieJar.value }
        : undefined,
  })),
}));

vi.mock("@oxagen/ai", () => ({
  resolvedTierCatalog: vi.fn(() => ({ models: [] })),
}));

vi.mock("./chat-shell-client", () => ({
  ChatShellClient: (props: Record<string, unknown>) => (
    <div
      data-testid="chat-shell-client"
      data-conversation-id={String(props.conversationId)}
      data-chat-ux-v2={String(props.chatUxV2)}
      data-org-slug={String(props.orgSlug)}
      data-workspace-slug={String(props.workspaceSlug)}
    />
  ),
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => (
    <div data-testid="skeleton" className={className} />
  ),
}));

vi.mock("./message-bubble", () => ({ ChatMessage: {} }));
vi.mock("./message-composer", () => ({ ComposerAction: {} }));
vi.mock("./mcp-types", () => ({}));
vi.mock("./model-picker", () => ({ ComposerModelState: {} }));
vi.mock("./stream-event-types", () => ({}));

// ── helpers ───────────────────────────────────────────────────────────────────

type MinimalProps = Pick<
  ChatShellProps,
  | "conversationId"
  | "conversationPublicId"
  | "activeLeafMessageId"
  | "messagesPromise"
  | "sendAction"
  | "resolveApprovalAction"
  | "resolveConsentAction"
  | "orgSlug"
  | "workspaceSlug"
>;

function makeProps(overrides: Partial<ChatShellProps> = {}): ChatShellProps {
  const defaults: MinimalProps = {
    conversationId: "conv_123",
    conversationPublicId: null,
    activeLeafMessageId: null,
    messagesPromise: Promise.resolve([]),
    sendAction: vi.fn() as unknown as ChatShellProps["sendAction"],
    resolveApprovalAction: vi.fn(() => Promise.resolve({ ok: true })),
    resolveConsentAction: vi.fn(() => Promise.resolve({ ok: true })),
    orgSlug: "my-org",
    workspaceSlug: "my-workspace",
  };
  return { ...defaults, ...overrides } as ChatShellProps;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("ChatShell", () => {
  it("shows MessagesSkeleton fallback while promise is pending", async () => {
    // Create a promise that never resolves so Suspense stays in fallback
    const neverResolves = new Promise<never>(() => {
      /* intentionally pending */
    });

    await act(async () => {
      render(
        <ChatShell
          {...makeProps({
            messagesPromise: neverResolves as unknown as Promise<[]>,
          })}
        />,
      );
    });

    // Should render skeleton fallback elements
    const skeletons = screen.getAllByTestId("skeleton");
    expect(skeletons.length).toBeGreaterThanOrEqual(1);

    // ChatShellClient should NOT be rendered yet
    expect(screen.queryByTestId("chat-shell-client")).toBeNull();
  });

  it("renders ChatShellClient with correct props after promise resolves", async () => {
    const messagesPromise = Promise.resolve([]);

    await act(async () => {
      render(
        <ChatShell
          {...makeProps({
            conversationId: "conv_abc",
            orgSlug: "acme",
            workspaceSlug: "ws-1",
            messagesPromise,
          })}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-shell-client")).toBeInTheDocument();
    });

    const client = screen.getByTestId("chat-shell-client");
    expect(client).toHaveAttribute("data-conversation-id", "conv_abc");
    expect(client).toHaveAttribute("data-org-slug", "acme");
    expect(client).toHaveAttribute("data-workspace-slug", "ws-1");
    // No cookie, no env default → the flag resolves off.
    expect(client).toHaveAttribute("data-chat-ux-v2", "false");
  });

  it("resolves the chat_ux_v2 cookie override into the chatUxV2 prop", async () => {
    mockCookieJar.value = "1";
    try {
      await act(async () => {
        render(
          <ChatShell
            {...makeProps({ messagesPromise: Promise.resolve([]) })}
          />,
        );
      });
      await waitFor(() => {
        expect(screen.getByTestId("chat-shell-client")).toHaveAttribute(
          "data-chat-ux-v2",
          "true",
        );
      });
    } finally {
      mockCookieJar.value = undefined;
    }
  });

  it("a chat_ux_v2=0 cookie forces the flag off even with the env default on", async () => {
    vi.stubEnv("NEXT_PUBLIC_CHAT_UX_V2", "1");
    mockCookieJar.value = "0";
    try {
      await act(async () => {
        render(
          <ChatShell
            {...makeProps({ messagesPromise: Promise.resolve([]) })}
          />,
        );
      });
      await waitFor(() => {
        expect(screen.getByTestId("chat-shell-client")).toHaveAttribute(
          "data-chat-ux-v2",
          "false",
        );
      });
    } finally {
      mockCookieJar.value = undefined;
      vi.unstubAllEnvs();
    }
  });

  it("works with null conversationId", async () => {
    const messagesPromise = Promise.resolve([]);

    await act(async () => {
      render(
        <ChatShell
          {...makeProps({
            conversationId: null,
            messagesPromise,
          })}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-shell-client")).toBeInTheDocument();
    });

    const client = screen.getByTestId("chat-shell-client");
    expect(client).toHaveAttribute("data-conversation-id", "null");
  });
});
