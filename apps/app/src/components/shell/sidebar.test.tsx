// @vitest-environment jsdom
/**
 * sidebar.test.tsx — render tests for Sidebar.
 *
 * Covers:
 *   - Renders aria-label="Primary navigation" aside
 *   - Has brand link to homeHref
 *   - Shows "Oxagen home" aria-label link
 *   - With collapsed=false: shows wordmark
 *   - With collapsed=true: hides wordmark
 *   - data-collapsed reflects useSidebar().collapsed
 *   - Renders primary nav items via renderItem
 *   - Renders footer section with UserSwitcher
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Mock: next/navigation
// ---------------------------------------------------------------------------
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/prod/sessions",
}));

// ---------------------------------------------------------------------------
// Mock: next/link
// ---------------------------------------------------------------------------
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/sidebar
// ---------------------------------------------------------------------------
vi.mock("@/lib/sidebar", () => ({
  activeHrefFor: vi.fn(
    (_pathname: string, hrefs: string[]) => hrefs[0] ?? null,
  ),
  getSidebarConfig: vi.fn(() => ({
    items: [
      {
        id: "sessions",
        label: "Sessions",
        icon: (): null => null,
        href: (ctx: { orgSlug: string; workspaceSlug?: string }) =>
          `/${ctx.orgSlug}/${ctx.workspaceSlug}/sessions`,
        group: "primary" as const,
      },
      {
        id: "settings",
        label: "Settings",
        icon: (): null => null,
        href: (ctx: { orgSlug: string; workspaceSlug?: string }) =>
          `/${ctx.orgSlug}/settings`,
        group: "footer" as const,
      },
    ],
    groupLabel: undefined,
    toolsLabel: undefined,
  })),
  resolveSidebarCtx: vi.fn(
    (_pathname: string, ctx: { orgSlug: string; workspaceSlug?: string }) => ({
      orgSlug: ctx.orgSlug ?? "acme",
      workspaceSlug: ctx.workspaceSlug ?? "prod",
    }),
  ),
  resolveSidebarMode: vi.fn(() => "workspace" as const),
}));

// ---------------------------------------------------------------------------
// Mock: @/components/shell/user-switcher
// ---------------------------------------------------------------------------
vi.mock("@/components/shell/user-switcher", () => ({
  UserSwitcher: ({ variant }: { variant?: string }) => (
    <div data-testid="user-switcher" data-variant={variant} />
  ),
}));

// ---------------------------------------------------------------------------
// Mock: @/components/ui/brand
// ---------------------------------------------------------------------------
vi.mock("@/components/ui/brand", () => ({
  BrandMark: () => <span data-testid="brand-mark">BrandMark</span>,
  OxagenWordmark: ({ className }: { className?: string }) => (
    <span data-testid="oxagen-wordmark" className={className}>
      Wordmark
    </span>
  ),
}));

// ---------------------------------------------------------------------------
// Mock: ./sidebar-context — default collapsed=false; overridden per test
// ---------------------------------------------------------------------------
const mockUseSidebar = vi.fn(() => ({ collapsed: false }));

vi.mock("./sidebar-context", () => ({
  useSidebar: () => mockUseSidebar(),
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/utils
// ---------------------------------------------------------------------------
vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// ---------------------------------------------------------------------------
// Mock: @/components/shell/sidebar-item
// ---------------------------------------------------------------------------
vi.mock("@/components/shell/sidebar-item", () => ({
  SidebarItem: ({ label }: { label: string; [key: string]: unknown }) => (
    <div data-testid={`sidebar-item-${label.toLowerCase()}`}>{label}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { Sidebar } from "./sidebar";
import type { ScopeContext } from "@/lib/scope";

const ctx: ScopeContext = { orgSlug: "acme", workspaceSlug: "prod" };
const user = {
  id: "u1",
  name: "Alice Test",
  email: "alice@example.com",
  image: null,
};

beforeEach(() => {
  mockUseSidebar.mockReturnValue({ collapsed: false });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sidebar — nav landmark", () => {
  it("renders aside with aria-label='Primary navigation'", () => {
    render(<Sidebar ctx={ctx} user={user} />);
    expect(
      screen.getByRole("complementary", { name: "Primary navigation" }),
    ).toBeInTheDocument();
  });

  it("data-collapsed is 'false' when not collapsed", () => {
    render(<Sidebar ctx={ctx} user={user} />);
    const aside = screen.getByRole("complementary", {
      name: "Primary navigation",
    });
    expect(aside).toHaveAttribute("data-collapsed", "false");
  });

  it("data-collapsed is 'true' when collapsed", () => {
    mockUseSidebar.mockReturnValue({ collapsed: true });
    render(<Sidebar ctx={ctx} user={user} />);
    const aside = screen.getByRole("complementary", {
      name: "Primary navigation",
    });
    expect(aside).toHaveAttribute("data-collapsed", "true");
  });
});

describe("Sidebar — brand link", () => {
  it("has a brand link with aria-label='Oxagen home'", () => {
    render(<Sidebar ctx={ctx} user={user} />);
    expect(
      screen.getByRole("link", { name: /oxagen home/i }),
    ).toBeInTheDocument();
  });

  it("brand link href points to workspace ask URL", () => {
    render(<Sidebar ctx={ctx} user={user} />);
    const link = screen.getByRole("link", { name: /oxagen home/i });
    expect(link).toHaveAttribute("href", "/acme/prod/sessions");
  });

  it("shows BrandMark", () => {
    render(<Sidebar ctx={ctx} user={user} />);
    expect(screen.getByTestId("brand-mark")).toBeInTheDocument();
  });
});

describe("Sidebar — wordmark visibility", () => {
  it("shows wordmark when not collapsed", () => {
    mockUseSidebar.mockReturnValue({ collapsed: false });
    render(<Sidebar ctx={ctx} user={user} />);
    expect(screen.getByTestId("oxagen-wordmark")).toBeInTheDocument();
  });

  it("hides wordmark when collapsed", () => {
    mockUseSidebar.mockReturnValue({ collapsed: true });
    render(<Sidebar ctx={ctx} user={user} />);
    expect(screen.queryByTestId("oxagen-wordmark")).not.toBeInTheDocument();
  });
});

describe("Sidebar — nav items", () => {
  it("renders primary nav item 'Sessions'", () => {
    render(<Sidebar ctx={ctx} user={user} />);
    expect(screen.getByTestId("sidebar-item-sessions")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
  });
});

describe("Sidebar — footer section", () => {
  it("renders UserSwitcher in the footer", () => {
    render(<Sidebar ctx={ctx} user={user} />);
    expect(screen.getByTestId("user-switcher")).toBeInTheDocument();
  });

  it("UserSwitcher has variant='full' when not collapsed", () => {
    mockUseSidebar.mockReturnValue({ collapsed: false });
    render(<Sidebar ctx={ctx} user={user} />);
    expect(screen.getByTestId("user-switcher")).toHaveAttribute(
      "data-variant",
      "full",
    );
  });

  it("UserSwitcher has variant='avatar' when collapsed", () => {
    mockUseSidebar.mockReturnValue({ collapsed: true });
    render(<Sidebar ctx={ctx} user={user} />);
    expect(screen.getByTestId("user-switcher")).toHaveAttribute(
      "data-variant",
      "avatar",
    );
  });
});
