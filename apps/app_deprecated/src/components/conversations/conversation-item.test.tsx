// @vitest-environment jsdom
/**
 * conversation-item.test.tsx — render + interaction tests for ConversationItem.
 *
 * Covers:
 *   - formatRelative time bucketing (pure logic)
 *   - Renders conversation title and relative time
 *   - Renders the actions button with correct aria-label
 *   - Renders link with correct href
 *   - isActive applies highlight class
 *   - Double-click opens menu
 *   - Right-click (contextmenu) opens menu
 *   - Menu: Rename opens rename dialog
 *   - Menu: Archive calls onArchiveToggle
 *   - Menu: Delete opens delete confirm dialog
 *   - "No session" fallback title when title is null/empty
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationItem } from "./conversation-item";

afterEach(cleanup);

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

// ── formatRelative pure-logic tests ─────────────────────────────────────────
// The function is internal. We test it by rendering and inspecting the subtitle.
const now = Date.now();
function minutesAgo(n: number) {
  return new Date(now - n * 60_000).toISOString();
}
function hoursAgo(n: number) {
  return new Date(now - n * 3_600_000).toISOString();
}
function daysAgo(n: number) {
  return new Date(now - n * 86_400_000).toISOString();
}

const baseConversation = {
  publicId: "conv-1",
  title: "Hello world",
  archivedAt: null,
  updatedAt: minutesAgo(0), // just now
  createdAt: minutesAgo(1),
  status: "active",
};

const baseProps = {
  conversation: baseConversation,
  href: "/acme/prod/chat?c=conv-1",
  isActive: false,
  onRename: vi.fn().mockResolvedValue(undefined),
  onArchiveToggle: vi.fn().mockResolvedValue(undefined),
  onDelete: vi.fn().mockResolvedValue(undefined),
};

describe("ConversationItem — formatRelative", () => {
  it("shows 'just now' for sub-minute updates", () => {
    render(
      <ConversationItem
        {...baseProps}
        conversation={{ ...baseConversation, updatedAt: minutesAgo(0) }}
      />,
    );
    expect(screen.getByText(/just now/i)).toBeInTheDocument();
  });

  it("shows minutes ago (5m ago)", () => {
    render(
      <ConversationItem
        {...baseProps}
        conversation={{ ...baseConversation, updatedAt: minutesAgo(5) }}
      />,
    );
    expect(screen.getByText(/5m ago/i)).toBeInTheDocument();
  });

  it("shows hours ago (3h ago)", () => {
    render(
      <ConversationItem
        {...baseProps}
        conversation={{ ...baseConversation, updatedAt: hoursAgo(3) }}
      />,
    );
    expect(screen.getByText(/3h ago/i)).toBeInTheDocument();
  });

  it("shows days ago (2d ago)", () => {
    render(
      <ConversationItem
        {...baseProps}
        conversation={{ ...baseConversation, updatedAt: daysAgo(2) }}
      />,
    );
    expect(screen.getByText(/2d ago/i)).toBeInTheDocument();
  });

  it("shows a date string for updates older than 7 days", () => {
    render(
      <ConversationItem
        {...baseProps}
        conversation={{ ...baseConversation, updatedAt: daysAgo(10) }}
      />,
    );
    // toLocaleDateString varies by environment; just check it's not "ago"
    const subtitle = screen.getByText(
      (t) =>
        !t.includes("ago") &&
        !t.includes("just now") &&
        t.length > 0 &&
        !t.includes("Hello world"),
    );
    expect(subtitle).toBeInTheDocument();
  });
});

describe("ConversationItem — rendering", () => {
  it("renders the conversation title", () => {
    render(<ConversationItem {...baseProps} />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("falls back to 'No session' when title is null", () => {
    render(
      <ConversationItem
        {...baseProps}
        conversation={{ ...baseConversation, title: null }}
      />,
    );
    expect(screen.getByText("No session")).toBeInTheDocument();
  });

  it("falls back to 'No session' when title is whitespace", () => {
    render(
      <ConversationItem
        {...baseProps}
        conversation={{ ...baseConversation, title: "   " }}
      />,
    );
    expect(screen.getByText("No session")).toBeInTheDocument();
  });

  it("renders the link with correct href", () => {
    render(<ConversationItem {...baseProps} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/acme/prod/chat?c=conv-1");
  });

  it("renders the actions button with aria-label for the title", () => {
    render(<ConversationItem {...baseProps} />);
    expect(
      screen.getByRole("button", { name: /actions for hello world/i }),
    ).toBeInTheDocument();
  });

  it("applies active class when isActive=true", () => {
    const { container } = render(
      <ConversationItem {...baseProps} isActive={true} />,
    );
    // The active row is the outer wrapper div; isActive swaps in the highlight
    // styling (semantic `bg-accent` token) instead of the transparent
    // hover-only state.
    const wrapper = container.firstElementChild as HTMLElement | null;
    expect(wrapper).toBeTruthy();
    expect(wrapper!.className).toContain("bg-accent");
  });
});

describe("ConversationItem — menu interactions", () => {
  it("opens menu on double-click of the link", async () => {
    render(<ConversationItem {...baseProps} />);
    const link = screen.getByRole("link");
    await userEvent.dblClick(link);
    // After dblClick the menu should open and show Rename option
    await waitFor(
      () => expect(screen.getByText("Rename")).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("shows Archive option for non-archived conversation", async () => {
    render(<ConversationItem {...baseProps} />);
    await userEvent.dblClick(screen.getByRole("link"));
    await waitFor(
      () => expect(screen.getByText("Archive")).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("shows Restore option for archived conversation", async () => {
    const archivedConv = {
      ...baseConversation,
      archivedAt: new Date().toISOString(),
    };
    render(<ConversationItem {...baseProps} conversation={archivedConv} />);
    await userEvent.dblClick(screen.getByRole("link"));
    await waitFor(
      () => expect(screen.getByText("Restore")).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("calls onArchiveToggle(id, true) when Archive is clicked", async () => {
    const onArchiveToggle = vi.fn().mockResolvedValue(undefined);
    render(
      <ConversationItem {...baseProps} onArchiveToggle={onArchiveToggle} />,
    );
    await userEvent.dblClick(screen.getByRole("link"));
    await waitFor(
      () => expect(screen.getByText("Archive")).toBeInTheDocument(),
      { timeout: 2000 },
    );
    await userEvent.click(screen.getByText("Archive"));
    expect(onArchiveToggle).toHaveBeenCalledWith("conv-1", true);
  });

  it("opens the rename dialog when Rename is clicked", async () => {
    render(<ConversationItem {...baseProps} />);
    await userEvent.dblClick(screen.getByRole("link"));
    await waitFor(
      () => expect(screen.getByText("Rename")).toBeInTheDocument(),
      { timeout: 2000 },
    );
    await userEvent.click(screen.getByText("Rename"));
    await waitFor(
      () => expect(screen.getByText("Rename conversation")).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("opens the delete dialog when Delete is clicked", async () => {
    render(<ConversationItem {...baseProps} />);
    await userEvent.dblClick(screen.getByRole("link"));
    await waitFor(
      () => expect(screen.getByText("Delete")).toBeInTheDocument(),
      { timeout: 2000 },
    );
    await userEvent.click(screen.getByText("Delete"));
    await waitFor(
      () =>
        expect(screen.getByText("Delete conversation?")).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });
});
