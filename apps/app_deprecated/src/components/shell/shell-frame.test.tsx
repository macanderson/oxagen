// @vitest-environment jsdom
/**
 * shell-frame.test.tsx — render tests for ShellFrame.
 *
 * Covers:
 *   - Renders main with id="main-content"
 *   - "Skip to main content" link renders (goes to #main-content)
 *   - Toggle button has aria-label="Toggle sidebar"
 *   - Children render inside main
 *   - Sidebar renders
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { ShellNavData } from "./shell-nav-slots";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Mock: next/navigation
// ---------------------------------------------------------------------------
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/prod/sessions",
}));

// ---------------------------------------------------------------------------
// Mock: ./sidebar
// ---------------------------------------------------------------------------
vi.mock("./sidebar", () => ({
  Sidebar: () => <aside data-testid="sidebar" />,
}));

// ---------------------------------------------------------------------------
// Mock: @/lib/sidebar
// ---------------------------------------------------------------------------
vi.mock("@/lib/sidebar", () => ({
  resolveSidebarCtx: vi.fn(
    (_pathname: string, ctx: { orgSlug: string; workspaceSlug?: string }) => ({
      orgSlug: ctx.orgSlug ?? "acme",
      workspaceSlug: ctx.workspaceSlug ?? "prod",
    }),
  ),
}));

// ---------------------------------------------------------------------------
// Mock: @/components/agent-panel/agent-bottom-bar
// ShellFrame renders <AgentBottomBar />, which calls useAgentPanelStore and
// requires an AgentPanelStoreProvider. Mock it so these layout tests don't
// need to wrap the tree in the agent-panel store provider.
// ---------------------------------------------------------------------------
vi.mock("@/components/agent-panel/agent-bottom-bar", () => ({
  AgentBottomBar: () => <div data-testid="agent-bottom-bar" />,
}));

// ---------------------------------------------------------------------------
// Mock: ./notifications-bell
// ---------------------------------------------------------------------------
vi.mock("./notifications-bell", () => ({
  NotificationsBell: () => <button>Bell</button>,
}));

// ---------------------------------------------------------------------------
// Mock: ./support-menu
// ---------------------------------------------------------------------------
vi.mock("./support-menu", () => ({
  SupportMenu: () => <button>Support</button>,
}));

// ---------------------------------------------------------------------------
// Mock: @/components/shell/ask/ask-bar
// ---------------------------------------------------------------------------
vi.mock("@/components/shell/ask/ask-bar", () => ({
  AskBar: () => <div data-testid="ask-bar" />,
}));

// ---------------------------------------------------------------------------
// Mock: ./shell-nav-slots
// ---------------------------------------------------------------------------
vi.mock("./shell-nav-slots", () => ({
  OrgSwitcherSlot: () => <div data-testid="org-switcher-slot" />,
  OrgSwitcherFallback: () => <div data-testid="org-switcher-fallback" />,
  WorkspaceSwitcherSlot: () => <div data-testid="workspace-switcher-slot" />,
  BalanceSlot: () => <div data-testid="balance-slot" />,
}));

// ---------------------------------------------------------------------------
// Mock: @/components/ui/button
// ---------------------------------------------------------------------------
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: {
    children?: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <button {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  ),
}));

// ---------------------------------------------------------------------------
// Mock: @/components/ui/tooltip
// ---------------------------------------------------------------------------
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    render: renderProp,
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement;
  }) => {
    // The ShellFrame passes a render prop with the Button already configured;
    // we need to render it to make the toggle button appear in the DOM.
    if (renderProp) {
      return (
        <>
          {renderProp}
          {children}
        </>
      );
    }
    return <>{children}</>;
  },
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// ---------------------------------------------------------------------------
// Mock: ./sidebar-context
// ---------------------------------------------------------------------------
const toggleMock = vi.fn();
vi.mock("./sidebar-context", () => ({
  useSidebar: () => ({ toggle: toggleMock, collapsed: false }),
}));

// ---------------------------------------------------------------------------
// Mock: @/components/workspace/new-workspace-form (type export only)
// ---------------------------------------------------------------------------
vi.mock("@/components/workspace/new-workspace-form", () => ({}));

// ---------------------------------------------------------------------------
// Mock: lucide-react
// ---------------------------------------------------------------------------
vi.mock("lucide-react", () => ({
  PanelLeft: () => <span>PL</span>,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { ShellFrame } from "./shell-frame";

const org = {
  id: "org-id-1",
  slug: "acme",
  name: "Acme Corp",
  publicId: "org_1",
};
const workspace = {
  id: "ws-id-1",
  orgId: "org-id-1",
  slug: "prod",
  name: "Production",
  publicId: "ws_1",
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

function renderShellFrame(children?: React.ReactNode) {
  return render(
    <ShellFrame
      org={org}
      workspace={workspace}
      navDataPromise={navDataPromise}
      user={user}
    >
      {children ?? <p>page content</p>}
    </ShellFrame>,
  );
}

describe("ShellFrame — main content area", () => {
  it("renders main element with id='main-content'", () => {
    renderShellFrame();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("renders children inside main", () => {
    renderShellFrame(<p data-testid="child">hello</p>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});

describe("ShellFrame — accessibility", () => {
  it("renders 'Skip to main content' link targeting #main-content", () => {
    renderShellFrame();
    const link = screen.getByText(/skip to main content/i);
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "#main-content");
  });
});

describe("ShellFrame — sidebar toggle", () => {
  it("renders a button with aria-label='Toggle sidebar'", () => {
    renderShellFrame();
    expect(
      screen.getByRole("button", { name: /toggle sidebar/i }),
    ).toBeInTheDocument();
  });
});

describe("ShellFrame — sidebar", () => {
  it("renders the Sidebar component", () => {
    renderShellFrame();
    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
  });
});

describe("ShellFrame — agent bottom bar", () => {
  it("renders the agent bottom bar by default", () => {
    renderShellFrame();
    expect(screen.getByTestId("agent-bottom-bar")).toBeInTheDocument();
  });

  it("suppresses the agent bottom bar when agentBar={false}", () => {
    // The workspace-less account section opts out — the bar consumes
    // useAgentPanelStore and would throw without an AgentPanelStoreProvider.
    render(
      <ShellFrame
        org={org}
        workspace={workspace}
        navDataPromise={navDataPromise}
        user={user}
        agentBar={false}
      >
        <p>page content</p>
      </ShellFrame>,
    );
    expect(screen.queryByTestId("agent-bottom-bar")).not.toBeInTheDocument();
  });
});
