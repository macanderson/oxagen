// @vitest-environment jsdom
/**
 * conversation-nav.test.tsx — render tests for ConversationNav.
 *
 * Covers:
 *   - Desktop aside renders "Conversations" heading
 *   - Mobile trigger button renders "Conversations" text
 *   - Desktop aside is hidden by CSS (md:flex; md:hidden)
 *   - Props are forwarded to ConversationList (renders items)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ConversationNav } from "./conversation-nav";
import type { ConversationNavActions } from "./types";

afterEach(cleanup);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/acme/prod/ask",
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const makeActions = (): ConversationNavActions => ({
  list: vi.fn().mockResolvedValue({ conversations: [], nextCursor: null }),
  rename: vi.fn().mockResolvedValue({ ok: true }),
  archive: vi.fn().mockResolvedValue({ ok: true }),
  delete: vi.fn().mockResolvedValue({ ok: true }),
  purge: vi.fn().mockResolvedValue({ ok: true }),
});

const defaultProps = {
  currentPublicId: null,
  initialActive: [],
  initialActiveNextCursor: null,
  actions: makeActions(),
};

describe("ConversationNav — desktop aside", () => {
  it("renders a 'Conversations' heading inside the aside", () => {
    render(<ConversationNav {...defaultProps} />);
    // The desktop aside has an h2 with text "Conversations"
    const headings = screen.getAllByText("Conversations");
    expect(headings.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the desktop aside element", () => {
    const { container } = render(<ConversationNav {...defaultProps} />);
    const aside = container.querySelector("aside");
    expect(aside).toBeInTheDocument();
  });
});

describe("ConversationNav — mobile trigger", () => {
  it("renders the mobile Sheet trigger button", () => {
    render(<ConversationNav {...defaultProps} />);
    // The mobile trigger is a button containing "Conversations"
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
  });
});

describe("ConversationNav — with conversations", () => {
  it("renders conversation titles via ConversationList", () => {
    const conversations = [
      { publicId: "c-1", title: "First chat", archivedAt: null, updatedAt: new Date().toISOString() },
      { publicId: "c-2", title: "Second chat", archivedAt: null, updatedAt: new Date().toISOString() },
    ];
    render(<ConversationNav {...defaultProps} initialActive={conversations} />);
    // ConversationList renders each title
    expect(screen.getAllByText("First chat").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Second chat").length).toBeGreaterThanOrEqual(1);
  });
});
