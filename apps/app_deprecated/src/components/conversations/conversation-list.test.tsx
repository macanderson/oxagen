// @vitest-environment jsdom
/**
 * conversation-list.test.tsx — render tests for ConversationList.
 *
 * Covers:
 *   - Renders "No session" button
 *   - Renders each conversation title from initialActive
 *   - Shows empty state (just the new-conversation button) when no conversations
 *   - Shows the "Archived" toggle section
 *   - Active conversation is highlighted (isActive class)
 *   - ConversationItems are rendered with correct href (pathname?c=publicId)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ConversationList } from "./conversation-list";
import type { ConversationNavActions } from "./types";

afterEach(cleanup);

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/acme/prod/sessions",
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const makeActions = (): ConversationNavActions => ({
  list: vi.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
  rename: vi.fn().mockResolvedValue({ ok: true }),
  archive: vi.fn().mockResolvedValue({ ok: true }),
  delete: vi.fn().mockResolvedValue({ ok: true }),
  purge: vi.fn().mockResolvedValue({ ok: true }),
});

const now = new Date().toISOString();

const conversations = [
  {
    publicId: "c-1",
    title: "Alpha chat",
    archivedAt: null,
    updatedAt: now,
    createdAt: now,
    status: "active",
  },
  {
    publicId: "c-2",
    title: "Beta chat",
    archivedAt: null,
    updatedAt: now,
    createdAt: now,
    status: "active",
  },
];

describe("ConversationList — rendering", () => {
  it("renders 'No session' button", () => {
    render(
      <ConversationList
        currentPublicId={null}
        initialActive={[]}
        initialActiveNextCursor={null}
        actions={makeActions()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /no session/i }),
    ).toBeInTheDocument();
  });

  it("renders each conversation from initialActive", () => {
    render(
      <ConversationList
        currentPublicId={null}
        initialActive={conversations}
        initialActiveNextCursor={null}
        actions={makeActions()}
      />,
    );
    expect(screen.getByText("Alpha chat")).toBeInTheDocument();
    expect(screen.getByText("Beta chat")).toBeInTheDocument();
  });

  it("renders conversation links with correct href", () => {
    render(
      <ConversationList
        currentPublicId={null}
        initialActive={conversations}
        initialActiveNextCursor={null}
        actions={makeActions()}
      />,
    );
    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("/acme/prod/sessions?c=c-1");
    expect(hrefs).toContain("/acme/prod/sessions?c=c-2");
  });

  it("renders 'Archived' toggle button", () => {
    render(
      <ConversationList
        currentPublicId={null}
        initialActive={[]}
        initialActiveNextCursor={null}
        actions={makeActions()}
      />,
    );
    expect(
      screen.getByRole("button", { name: /archived/i }),
    ).toBeInTheDocument();
  });
});

describe("ConversationList — active state", () => {
  it("highlights the active conversation item", () => {
    const { container } = render(
      <ConversationList
        currentPublicId="c-1"
        initialActive={conversations}
        initialActiveNextCursor={null}
        actions={makeActions()}
      />,
    );
    // The active item swaps in the semantic highlight styling (`bg-accent`)
    // instead of the transparent hover-only state — see conversation-item.tsx.
    const activeItem = Array.from(container.querySelectorAll("div")).find(
      (el) => el.className.includes("bg-accent"),
    );
    expect(activeItem).toBeInTheDocument();
  });
});
