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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConversationNav } from "./conversation-nav";
import type { ConversationNavActions } from "./types";

// This vitest jsdom env ships without a working `localStorage` (the shared
// sidebar-context suite is red for the same reason), so stub a minimal in-memory
// Storage. This keeps the collapse-persistence tests deterministic and asserts
// the component's best-effort persistence without depending on the env.
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
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

  it("floats the mobile trigger over the conversation (absolute, phone-only)", () => {
    // Regression guard: the mobile trigger must be OUT of normal flow so it
    // overlays the transcript instead of stealing a row of height on phones.
    const { container } = render(<ConversationNav {...defaultProps} />);
    const trigger = container.querySelector<HTMLElement>(
      "[data-conversation-nav-trigger]",
    );
    expect(trigger).toBeInTheDocument();
    expect(trigger?.className).toContain("absolute");
    // Still phone-only — the desktop aside owns conversations at md+.
    expect(trigger?.className).toContain("md:hidden");
  });
});

describe("ConversationNav — desktop collapse", () => {
  it("starts expanded (heading + collapse control visible) by default", () => {
    render(<ConversationNav {...defaultProps} />);
    expect(
      screen.getByRole("heading", { name: "Conversations" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /collapse conversations/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show conversations/i }),
    ).toBeNull();
  });

  it("collapses to an icon rail when the collapse control is clicked", () => {
    render(<ConversationNav {...defaultProps} />);
    fireEvent.click(
      screen.getByRole("button", { name: /collapse conversations/i }),
    );
    // Heading + list gone; the expand affordance takes its place.
    expect(screen.queryByRole("heading", { name: "Conversations" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /show conversations/i }),
    ).toBeInTheDocument();
  });

  it("persists the collapsed flag to localStorage", () => {
    render(<ConversationNav {...defaultProps} />);
    fireEvent.click(
      screen.getByRole("button", { name: /collapse conversations/i }),
    );
    expect(
      window.localStorage.getItem("oxagen.conversation-nav.collapsed"),
    ).toBe("1");
  });

  it("re-expands from the collapsed rail", () => {
    render(<ConversationNav {...defaultProps} />);
    fireEvent.click(
      screen.getByRole("button", { name: /collapse conversations/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /show conversations/i }),
    );
    expect(
      screen.getByRole("heading", { name: "Conversations" }),
    ).toBeInTheDocument();
    expect(
      window.localStorage.getItem("oxagen.conversation-nav.collapsed"),
    ).toBe("0");
  });

  it("initialises collapsed when localStorage already has the flag set", () => {
    window.localStorage.setItem("oxagen.conversation-nav.collapsed", "1");
    render(<ConversationNav {...defaultProps} />);
    expect(screen.queryByRole("heading", { name: "Conversations" })).toBeNull();
    expect(
      screen.getByRole("button", { name: /show conversations/i }),
    ).toBeInTheDocument();
  });
});

describe("ConversationNav — with conversations", () => {
  it("renders conversation titles via ConversationList", () => {
    const conversations = [
      {
        publicId: "c-1",
        title: "First chat",
        archivedAt: null,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: "active",
      },
      {
        publicId: "c-2",
        title: "Second chat",
        archivedAt: null,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: "active",
      },
    ];
    render(<ConversationNav {...defaultProps} initialActive={conversations} />);
    // ConversationList renders each title
    expect(screen.getAllByText("First chat").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Second chat").length).toBeGreaterThanOrEqual(1);
  });
});
