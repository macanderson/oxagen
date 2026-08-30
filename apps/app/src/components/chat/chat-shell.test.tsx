// @vitest-environment jsdom
/**
 * chat-shell.test.tsx
 *
 * Unit tests for the ChatShell RSC wrapper:
 *   1. Shows MessagesSkeleton fallback while promise is pending
 *   2. After promise resolves, ChatShellClient receives correct props
 *   3. BackgroundTaskTray is always rendered (outside Suspense)
 *   4. Works with null conversationId
 *   5. Works when initialBackgroundTaskIds is empty/undefined
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

vi.mock("./background-task-tray", () => ({
  BackgroundTaskTray: ({
    initialTaskIds,
  }: {
    initialTaskIds?: string[];
    fetchTask?: unknown;
    cancelTask?: unknown;
  }) => (
    <div
      data-testid="background-task-tray"
      data-task-ids={JSON.stringify(initialTaskIds ?? [])}
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
vi.mock("./plan-card", () => ({ AgentCapability: {} }));
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
  | "resolvePlanAction"
  | "fetchBackgroundTask"
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
    resolvePlanAction: vi.fn(() => Promise.resolve({ ok: true })),
    fetchBackgroundTask: vi.fn((_taskId: string) =>
      Promise.resolve({
        taskId: "task_1",
        kind: "generic",
        status: "running" as const,
        label: "Test task",
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        progress: 0,
      }),
    ) as ChatShellProps["fetchBackgroundTask"],
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

  it("renders BackgroundTaskTray outside Suspense immediately", async () => {
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

    // BackgroundTaskTray must be present even while Suspense fallback is showing
    expect(screen.getByTestId("background-task-tray")).toBeInTheDocument();
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

  it("works when initialBackgroundTaskIds is undefined", async () => {
    const neverResolves = new Promise<never>(() => {
      /* intentionally pending */
    });

    await act(async () => {
      render(
        <ChatShell
          {...makeProps({
            messagesPromise: neverResolves as unknown as Promise<[]>,
            initialBackgroundTaskIds: undefined,
          })}
        />,
      );
    });

    const tray = screen.getByTestId("background-task-tray");
    expect(tray).toBeInTheDocument();
    expect(tray).toHaveAttribute("data-task-ids", "[]");
  });

  it("works when initialBackgroundTaskIds is empty array", async () => {
    const neverResolves = new Promise<never>(() => {
      /* intentionally pending */
    });

    await act(async () => {
      render(
        <ChatShell
          {...makeProps({
            messagesPromise: neverResolves as unknown as Promise<[]>,
            initialBackgroundTaskIds: [],
          })}
        />,
      );
    });

    const tray = screen.getByTestId("background-task-tray");
    expect(tray).toBeInTheDocument();
    expect(tray).toHaveAttribute("data-task-ids", "[]");
  });

  it("passes initialBackgroundTaskIds to BackgroundTaskTray", async () => {
    const neverResolves = new Promise<never>(() => {
      /* intentionally pending */
    });

    await act(async () => {
      render(
        <ChatShell
          {...makeProps({
            messagesPromise: neverResolves as unknown as Promise<[]>,
            initialBackgroundTaskIds: ["task_1", "task_2"],
          })}
        />,
      );
    });

    const tray = screen.getByTestId("background-task-tray");
    expect(tray).toHaveAttribute(
      "data-task-ids",
      JSON.stringify(["task_1", "task_2"]),
    );
  });
});
