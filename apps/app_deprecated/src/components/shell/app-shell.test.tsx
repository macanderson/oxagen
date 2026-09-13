// @vitest-environment jsdom
/**
 * app-shell.test.tsx — render tests for AppShell.
 *
 * AppShell is a server component (no hooks). It:
 *   - Wraps children in SidebarProvider
 *   - Renders ShellFrame with all props passed through
 *   - Renders MobileBottomBar
 *
 * Covers:
 *   - Renders ShellFrame with children passed through
 *   - Renders MobileBottomBar
 *   - Wraps in SidebarProvider
 *   - Passes org and workspace props through
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Mock: ./sidebar-context
// ---------------------------------------------------------------------------
vi.mock("./sidebar-context", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock: ./shell-frame
// ---------------------------------------------------------------------------
vi.mock("./shell-frame", () => ({
  ShellFrame: ({
    children,
    org,
    workspace,
  }: {
    children: React.ReactNode;
    org: { slug: string; name: string };
    workspace?: { slug: string };
  }) => (
    <div
      data-testid="shell-frame"
      data-org={org.slug}
      data-workspace={workspace?.slug}
    >
      {children}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Mock: ./mobile-bottom-bar
// ---------------------------------------------------------------------------
vi.mock("./mobile-bottom-bar", () => ({
  MobileBottomBar: ({
    ctx,
  }: {
    ctx: { orgSlug: string; workspaceSlug?: string };
  }) => <div data-testid="mobile-bottom-bar" data-org={ctx.orgSlug} />,
}));

// ---------------------------------------------------------------------------
// Mock: @/app/[orgSlug]/new-workspace/actions
// ---------------------------------------------------------------------------
vi.mock("@/app/[orgSlug]/new-workspace/actions", () => ({
  createWorkspaceAction: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: ./shell-nav-slots (type exports only; no runtime values needed)
// ---------------------------------------------------------------------------
vi.mock("./shell-nav-slots", () => ({}));

// ---------------------------------------------------------------------------
// Mock: @/components/workspace/new-workspace-form (type export only)
// ---------------------------------------------------------------------------
vi.mock("@/components/workspace/new-workspace-form", () => ({}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { AppShell } from "./app-shell";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";
import type { ShellNavData } from "./shell-nav-slots";

const org: ResolvedOrg = {
  id: "org_uuid_1",
  publicId: "org_1",
  name: "Acme Corp",
  slug: "acme",
};
const workspace: ResolvedWorkspace = {
  id: "ws_uuid_1",
  publicId: "ws_1",
  orgId: "org_uuid_1",
  name: "Production",
  slug: "prod",
  description: "",
  avatarUrl: null,
};
const user = {
  id: "u1",
  name: "Alice",
  email: "alice@example.com",
  image: null,
};
const navDataPromise: Promise<ShellNavData> = Promise.resolve({
  availableOrgs: [],
  availableWorkspaces: [],
  balance: null,
});

describe("AppShell — structure", () => {
  it("renders ShellFrame", () => {
    render(
      <AppShell
        org={org}
        workspace={workspace}
        navDataPromise={navDataPromise}
        user={user}
      >
        <p>page content</p>
      </AppShell>,
    );
    expect(screen.getByTestId("shell-frame")).toBeInTheDocument();
  });

  it("renders MobileBottomBar", () => {
    render(
      <AppShell
        org={org}
        workspace={workspace}
        navDataPromise={navDataPromise}
        user={user}
      >
        <p>page content</p>
      </AppShell>,
    );
    expect(screen.getByTestId("mobile-bottom-bar")).toBeInTheDocument();
  });

  it("wraps content in SidebarProvider", () => {
    render(
      <AppShell
        org={org}
        workspace={workspace}
        navDataPromise={navDataPromise}
        user={user}
      >
        <p>page content</p>
      </AppShell>,
    );
    expect(screen.getByTestId("sidebar-provider")).toBeInTheDocument();
  });

  it("passes children through ShellFrame", () => {
    render(
      <AppShell
        org={org}
        workspace={workspace}
        navDataPromise={navDataPromise}
        user={user}
      >
        <p data-testid="child-content">hello world</p>
      </AppShell>,
    );
    expect(screen.getByTestId("child-content")).toBeInTheDocument();
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("passes org slug to ShellFrame", () => {
    render(
      <AppShell
        org={org}
        workspace={workspace}
        navDataPromise={navDataPromise}
        user={user}
      >
        <p>content</p>
      </AppShell>,
    );
    expect(screen.getByTestId("shell-frame")).toHaveAttribute(
      "data-org",
      "acme",
    );
  });

  it("passes workspace slug to ShellFrame", () => {
    render(
      <AppShell
        org={org}
        workspace={workspace}
        navDataPromise={navDataPromise}
        user={user}
      >
        <p>content</p>
      </AppShell>,
    );
    expect(screen.getByTestId("shell-frame")).toHaveAttribute(
      "data-workspace",
      "prod",
    );
  });

  it("renders without a workspace (org-only route)", () => {
    render(
      <AppShell org={org} navDataPromise={navDataPromise} user={user}>
        <p>content</p>
      </AppShell>,
    );
    expect(screen.getByTestId("shell-frame")).toBeInTheDocument();
    expect(screen.getByTestId("shell-frame")).not.toHaveAttribute(
      "data-workspace",
    );
  });
});
