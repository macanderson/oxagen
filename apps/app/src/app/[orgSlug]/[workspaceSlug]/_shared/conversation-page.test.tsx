// @vitest-environment jsdom
/**
 * conversation-page.test.tsx — layout regression guard for the chat/ask page.
 *
 * Regression: the chat composer (Send button) on the mobile-portrait Ask page
 * flowed far below the fold and sat behind the fixed MobileBottomBar, so users
 * could not see or tap Send. Root cause: the chat content column
 * (`min-w-0 flex-1`) was a `flex-col` flex item WITHOUT `min-h-0`, so it could
 * not shrink below its intrinsic content height. The inner
 * `min-h-0 flex-1 overflow-y-auto` message scroller therefore never engaged on
 * mobile — the whole conversation grew taller than the viewport and the
 * bottom-pinned composer was pushed off-screen. On desktop the same column is a
 * `md:flex-row` item (height auto-stretched), so it only manifested on mobile.
 *
 * Fix: add `min-h-0` to the content column so flexbox can bound its height and
 * the inner scroller engages, pinning the composer inside the viewport above
 * the bottom bar. This test asserts that class contract on the rendered layout
 * — it fails on the old markup (`min-w-0 flex-1`) and passes on the new
 * (`min-h-0 min-w-0 flex-1`).
 *
 * See: shell-frame `<main>` reserves the bottom-bar clearance via
 * `max-md:pb-[calc(var(--bottom-bar-h)+var(--bottom-bar-gap)+env(safe-area-inset-bottom))]`;
 * that clearance only helps once the column is height-bounded so the composer
 * actually lands at the bottom of the viewport rather than below the fold.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

afterEach(cleanup);

// Observe the degrade log emitted by conversation-page's logAndFallback helper.
const mockLoggerWarn = vi.hoisted(() => vi.fn());
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { warn: mockLoggerWarn, error: vi.fn(), info: vi.fn() },
}));

// ── Heavy server-only dependency stubs ──────────────────────────────────────
// ConversationPage is an async RSC; we mock its DB / tenancy / handler / AI
// imports so we can await it and render its returned tree in jsdom, then assert
// the static layout class contract.

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock("@oxagen/database", () => ({
  withTenantDb: vi.fn(async () => []),
  schema: {
    conversations: {
      publicId: "publicId",
      orgId: "orgId",
      workspaceId: "workspaceId",
      archivedAt: "archivedAt",
      deletedAt: "deletedAt",
      updatedAt: "updatedAt",
    },
    messages: { conversationId: "conversationId", createdAt: "createdAt" },
    mcpServers: {
      publicId: "publicId",
      name: "name",
      healthStatus: "healthStatus",
      discoveredTools: "discoveredTools",
      orgListingId: "orgListingId",
      orgId: "orgId",
      workspaceId: "workspaceId",
      enabled: "enabled",
    },
    pluginInstalledPlugins: { id: "id", enabled: "enabled", deletedAt: "deletedAt" },
  },
}));

vi.mock("@oxagen/tenancy", () => ({
  // Run the callback so the inner withTenantDb mocks resolve.
  runInTenantScope: vi.fn(async (_scope: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(async () => ({ id: "org-1", slug: "acme", name: "Acme", publicId: "org_1" })),
  resolveWorkspace: vi.fn(async () => ({
    id: "ws-1",
    orgId: "org-1",
    slug: "prod",
    name: "Prod",
    publicId: "ws_1",
    description: "",
  })),
}));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: vi.fn(async () => ({ user: { id: "u1", name: "Alice", email: "a@x.io" } })),
}));

// Stub ChatShell so the test does not pull in the full streaming client tree.
vi.mock("@/components/chat/chat-shell", () => ({
  ChatShell: () => <div data-testid="chat-shell" />,
}));

// Stub ConversationNav (its own client tree is irrelevant to this layout guard).
vi.mock("@/components/conversations/conversation-nav", () => ({
  ConversationNav: () => <nav data-testid="conversation-nav" />,
}));

vi.mock("@oxagen/oxagen", () => ({
  listCapabilities: vi.fn(() => []),
  getSurfaces: vi.fn(() => []),
}));

vi.mock("@oxagen/ai", () => ({
  loadEffectiveModelDefaults: vi.fn(async () => null),
}));

vi.mock("@/components/chat/model-state", () => ({
  buildSeededModelState: vi.fn(() => undefined),
}));

vi.mock("@oxagen/handlers/user.preferences.read", () => ({
  userPreferencesReadHandler: vi.fn(async () => ({
    enterToSubmit: false,
    pendingPromptBehavior: "queue",
  })),
}));

vi.mock("@oxagen/handlers/conversation.list", () => ({
  conversationListHandler: vi.fn(async () => ({ conversations: [], nextCursor: null })),
}));

vi.mock("./conversation-actions", () => ({
  listConversationsAction: vi.fn(),
  renameConversationAction: vi.fn(),
  archiveConversationsAction: vi.fn(),
  deleteConversationsAction: vi.fn(),
  purgeArchivedConversationsAction: vi.fn(),
}));

vi.mock("./walk-active-branch", () => ({
  walkActiveBranch: vi.fn(() => []),
}));

// ── Import after mocks ───────────────────────────────────────────────────────
import { ConversationPage } from "./conversation-page";
import { userPreferencesReadHandler } from "@oxagen/handlers/user.preferences.read";

const actions = {
  sendMessageAction: vi.fn(),
  resolveApprovalAction: vi.fn(),
  resolveConsentAction: vi.fn(),
  resolvePlanAction: vi.fn(),
  cancelBackgroundTaskAction: vi.fn(),
  readBackgroundTaskAction: vi.fn(),
} as unknown as Parameters<typeof ConversationPage>[0]["actions"];

async function renderPage() {
  // Await the async server component to obtain its element tree, then render it.
  const element = await ConversationPage({
    params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "prod" }),
    searchParams: Promise.resolve({}),
    actions,
  });
  return render(element);
}

describe("ConversationPage — mobile composer clearance layout contract", () => {
  it("gives the chat content column min-h-0 so its flex height is bounded (composer stays in viewport)", async () => {
    const { container } = await renderPage();
    const chatShell = container.querySelector('[data-testid="chat-shell"]');
    expect(chatShell).not.toBeNull();

    // The content column wraps `mx-auto h-full max-w-4xl` → ChatShell. Walk up
    // from ChatShell to that flex-1 column and assert it carries min-h-0.
    const innerWrap = chatShell!.parentElement; // mx-auto h-full max-w-4xl
    const contentColumn = innerWrap!.parentElement; // min-h-0 min-w-0 flex-1

    expect(innerWrap!.className).toContain("h-full");
    expect(contentColumn!.className).toContain("flex-1");
    // The regression guard: WITHOUT min-h-0 this flex-col item cannot shrink,
    // so the inner scroller never engages and the composer is pushed off-screen
    // behind the mobile bottom bar.
    expect(contentColumn!.className).toContain("min-h-0");
  });

  it("keeps the root a column on mobile that becomes a row on desktop (height auto-bounds on md+)", async () => {
    const { container } = await renderPage();
    const chatShell = container.querySelector('[data-testid="chat-shell"]');
    const root = chatShell!.parentElement!.parentElement!.parentElement; // flex h-full flex-col md:flex-row

    expect(root!.className).toContain("h-full");
    expect(root!.className).toContain("flex-col");
    expect(root!.className).toContain("md:flex-row");
  });
});

describe("ConversationPage — non-fatal degrade logging", () => {
  afterEach(() => {
    mockLoggerWarn.mockClear();
  });

  it("logs a degrade warning and still renders the page when a parallel read rejects", async () => {
    // user-preferences read fails — the page must degrade to defaults, log the
    // failure, and still render the chat shell (never crash).
    vi.mocked(userPreferencesReadHandler).mockRejectedValueOnce(
      new Error("RLS: permission denied"),
    );

    const { container } = await renderPage();

    // Page still rendered.
    expect(container.querySelector('[data-testid="chat-shell"]')).not.toBeNull();

    // Failure was logged with the degrade context.
    expect(mockLoggerWarn).toHaveBeenCalled();
    const call = mockLoggerWarn.mock.calls.find(
      ([, msg]) => typeof msg === "string" && /user-preferences read/.test(msg),
    ) as [Record<string, unknown>, string] | undefined;
    expect(call).toBeDefined();
    expect(call![0].err).toBeInstanceOf(Error);
    expect(call![1]).toMatch(/degraded/i);
  });
});
