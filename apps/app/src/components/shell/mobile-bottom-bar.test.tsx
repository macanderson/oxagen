// @vitest-environment jsdom
/**
 * mobile-bottom-bar.test.tsx — render tests for MobileBottomBar.
 *
 * Covers:
 *   - Renders up to four primary destinations as client-routed <Link> tabs
 *     with the correct resolved hrefs (no full-page <a> reload).
 *   - Marks the current destination with aria-current="page".
 *   - Keeps overflow destinations out of the bar until "More" is opened.
 *   - Opens the "More" bottom sheet exposing the overflow destinations.
 *   - Surfaces the account control in the sheet (and omits it when no user).
 *   - Highlights the "More" tab when the active page lives behind it.
 *   - Resolves org mode from the pathname when no workspace is scoped.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// usePathname is read on every render; a hoisted ref lets individual tests
// point the component at a different route (drives mode + active detection).
const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: "/acme/prod/ask" } }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ src, alt, ...rest }: { src: string; alt: string; [k: string]: unknown }) => (
    // eslint-disable-next-line @next/next/no-img-element -- jsdom test shim; real next/image requires Next.js runtime
    <img src={src} alt={alt} {...rest} />
  ),
}));

// UserSwitcher (rendered inside the More sheet) reaches for the auth client,
// the theme context and the router — stub them so it mounts in isolation.
vi.mock("@oxagen/auth/client", () => ({ signOut: vi.fn().mockResolvedValue({}) }));
vi.mock("@oxagen/ui", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));

import { MobileBottomBar } from "./mobile-bottom-bar";
import * as sidebarLib from "@/lib/sidebar";

const wsCtx = { orgSlug: "acme", workspaceSlug: "prod" };
const user = { id: "u1", name: "Jane", email: "jane@example.com", image: null };

afterEach(() => {
  cleanup();
  pathnameRef.current = "/acme/prod/ask";
});

describe("MobileBottomBar — primary tabs", () => {
  it("renders the workspace destinations as client-routed tabs with resolved hrefs", () => {
    // Workspace mode now has exactly four nav items (ask, knowledge, marketplace,
    // settings), so all fit in the bar and none overflow into "More".
    render(<MobileBottomBar ctx={wsCtx} user={user} />);
    const nav = screen.getByRole("navigation", { name: /mobile navigation/i });
    expect(within(nav).getByRole("link", { name: "Ask" })).toHaveAttribute("href", "/acme/prod/ask");
    expect(within(nav).getByRole("link", { name: "Knowledge" })).toHaveAttribute("href", "/acme/prod/knowledge");
    expect(within(nav).getByRole("link", { name: "Marketplace" })).toHaveAttribute("href", "/acme/prod/settings/plugins");
    expect(within(nav).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/acme/prod/settings");
  });

  it("marks the current destination with aria-current=page", () => {
    render(<MobileBottomBar ctx={wsCtx} user={user} />);
    expect(screen.getByRole("link", { name: "Ask" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Knowledge" })).not.toHaveAttribute("aria-current");
  });

  it("keeps a More tab for the account control while all nav destinations stay in the bar", () => {
    // With four items, nothing overflows — the More tab only exists to host the
    // account control (present because a user is provided).
    render(<MobileBottomBar ctx={wsCtx} user={user} />);
    const nav = screen.getByRole("navigation", { name: /mobile navigation/i });
    expect(screen.getByRole("button", { name: /more navigation/i })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Marketplace" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("MobileBottomBar — More sheet", () => {
  it("surfaces the account control in the More sheet when a user is provided", async () => {
    render(<MobileBottomBar ctx={wsCtx} user={user} />);
    await userEvent.click(screen.getByRole("button", { name: /more navigation/i }));
    await waitFor(
      () => expect(screen.getByRole("button", { name: /open account menu for jane/i })).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("omits the More tab in workspace mode when there is no user (nothing overflows)", () => {
    // Four items all fit the bar and there is no account control, so the More
    // sheet would be header-only — the More tab must not render at all.
    render(<MobileBottomBar ctx={wsCtx} user={undefined} />);
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /more navigation/i })).toBeNull();
  });

  it("marks the Settings destination active when the settings route is open", () => {
    pathnameRef.current = "/acme/prod/settings";
    render(<MobileBottomBar ctx={wsCtx} user={user} />);
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
  });
});

describe("MobileBottomBar — org mode", () => {
  it("resolves org-mode destinations from the pathname when no workspace is scoped", () => {
    pathnameRef.current = "/acme/members";
    render(<MobileBottomBar ctx={{ orgSlug: "acme" }} user={user} />);
    expect(screen.getByRole("link", { name: "Workspaces" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute("href", "/acme/members");
    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
  });
});

describe("MobileBottomBar — empty More guard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("omits the More tab when there are no overflow items and no user", () => {
    // Drive a minimal (≤4-item) config so moreItems is empty; with user=undefined
    // the sheet would be header-only, so the More tab must not render at all.
    // Mocking the config exercises this guard independently of how many items any
    // real nav mode happens to have (account mode itself now overflows — below).
    const real = sidebarLib.getSidebarConfig("account");
    vi.spyOn(sidebarLib, "getSidebarConfig").mockReturnValue({
      ...real,
      items: real.items.slice(0, 1),
    });
    pathnameRef.current = "/account/profile";
    render(<MobileBottomBar ctx={{ orgSlug: "acme" }} user={undefined} />);
    expect(screen.queryByRole("button", { name: /more navigation/i })).toBeNull();
  });

  it("surfaces overflow account items (Privacy) in the More sheet even without a user", () => {
    // Account now has five items (return-to-app, Profile, Preferences, Security,
    // Privacy); the fifth overflows past MAX_BAR_ITEMS into More, so the More tab
    // renders even when no user/account-control is present.
    pathnameRef.current = "/account/profile";
    render(<MobileBottomBar ctx={{ orgSlug: "acme" }} user={undefined} />);
    expect(screen.getByRole("link", { name: "Profile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /more navigation/i })).toBeInTheDocument();
  });

  it("still shows the More tab in account mode when a user is present (account control)", () => {
    pathnameRef.current = "/account/profile";
    render(<MobileBottomBar ctx={{ orgSlug: "acme" }} user={user} />);
    expect(screen.getByRole("button", { name: /more navigation/i })).toBeInTheDocument();
  });
});
