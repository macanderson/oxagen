// @vitest-environment jsdom
/**
 * shell-nav-slots.test.tsx — render tests for shell nav slot components.
 *
 * These components use React's `use()` hook with Suspense. Tests wrap each
 * component in a <Suspense> boundary. Because React 19 + JSDOM requires async
 * act() wrapping to flush Suspense, we use a helper that renders inside act()
 * so the resolved state is available for synchronous assertions immediately
 * after the helper returns.
 *
 * Covers:
 *   - OrgSwitcherFallback: renders aria-hidden skeleton
 *   - OrgSwitcherSlot: renders OrgSwitcher with orgs from resolved promise
 *   - WorkspaceSwitcherSlot: returns null when no current workspace
 *   - WorkspaceSwitcherSlot: renders WorkspaceSwitcher when workspace exists
 *   - BalanceSlot: returns null when balance is null
 *   - BalanceSlot: renders BalancePill when balance data exists
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import { render, act } from "@testing-library/react";
import { Suspense } from "react";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Mock: next/navigation
// ---------------------------------------------------------------------------
vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/prod/ask",
}));

// ---------------------------------------------------------------------------
// Mock: @/components/org/org-switcher
// ---------------------------------------------------------------------------
vi.mock("@/components/org/org-switcher", () => ({
  OrgSwitcher: ({
    current,
    organizations,
  }: {
    current: { slug: string };
    organizations: unknown[];
  }) => (
    <div
      data-testid="org-switcher"
      data-current={current.slug}
      data-orgs-count={organizations.length}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Mock: @/components/workspace/workspace-switcher
// ---------------------------------------------------------------------------
vi.mock("@/components/workspace/workspace-switcher", () => ({
  WorkspaceSwitcher: ({
    current,
  }: {
    orgSlug: string;
    current: { slug: string };
    workspaces: unknown[];
    createWorkspaceAction?: unknown;
  }) => <div data-testid="workspace-switcher" data-current={current.slug} />,
}));

// ---------------------------------------------------------------------------
// Mock: ./balance-pill
// ---------------------------------------------------------------------------
vi.mock("./balance-pill", () => ({
  BalancePill: ({
    orgSlug,
    balanceCents,
  }: {
    orgSlug: string;
    balanceCents: number;
    low: boolean;
  }) => (
    <div
      data-testid="balance-pill"
      data-org={orgSlug}
      data-cents={balanceCents}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Mock: @/components/ui/skeleton
// ---------------------------------------------------------------------------
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({
    className,
    ...props
  }: {
    className?: string;
    [key: string]: unknown;
  }) => (
    <div
      data-testid="skeleton"
      className={className}
      {...(props as React.HTMLAttributes<HTMLDivElement>)}
    />
  ),
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
// Mock: @/components/workspace/new-workspace-form (type export only)
// ---------------------------------------------------------------------------
vi.mock("@/components/workspace/new-workspace-form", () => ({}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import {
  OrgSwitcherFallback,
  OrgSwitcherSlot,
  WorkspaceSwitcherSlot,
  BalanceSlot,
  type ShellNavData,
} from "./shell-nav-slots";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

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

const orgs = [
  { publicId: "org_1", slug: "acme", name: "Acme Corp", logoUrl: null },
];

const workspaces = [{ publicId: "ws_1", slug: "prod", name: "Production" }];

function makeNavPromise(
  overrides: Partial<ShellNavData> = {},
): Promise<ShellNavData> {
  return Promise.resolve({
    availableOrgs: orgs,
    availableWorkspaces: workspaces,
    balance: null,
    ...overrides,
  });
}

/**
 * Render a Suspense-wrapped component and flush the promise so the `use()` hook
 * resolves before assertions. React 19 Suspense + JSDOM requires the render AND
 * the promise flush to both happen inside the same `act()` call.
 */
async function renderSuspended(
  ui: React.ReactElement,
  promise: Promise<ShellNavData>,
): Promise<void> {
  await act(async () => {
    render(
      <Suspense fallback={<div data-testid="suspense-fallback">loading</div>}>
        {ui}
      </Suspense>,
    );
    // Flush microtasks so the promise resolves and React re-renders
    await promise;
    // Flush any remaining microtasks
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// OrgSwitcherFallback
// ---------------------------------------------------------------------------

describe("OrgSwitcherFallback", () => {
  it("renders a skeleton element", () => {
    render(<OrgSwitcherFallback />);
    expect(screen.getByTestId("skeleton")).toBeInTheDocument();
  });

  it("skeleton has aria-hidden='true'", () => {
    render(<OrgSwitcherFallback />);
    expect(screen.getByTestId("skeleton")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});

// ---------------------------------------------------------------------------
// OrgSwitcherSlot
// ---------------------------------------------------------------------------

describe("OrgSwitcherSlot", () => {
  it("renders OrgSwitcher with org list from resolved promise", async () => {
    const promise = makeNavPromise({ availableOrgs: orgs });
    await renderSuspended(
      <OrgSwitcherSlot org={org} navDataPromise={promise} />,
      promise,
    );
    expect(screen.getByTestId("org-switcher")).toBeInTheDocument();
  });

  it("passes current org to OrgSwitcher", async () => {
    const promise = makeNavPromise({ availableOrgs: orgs });
    await renderSuspended(
      <OrgSwitcherSlot org={org} navDataPromise={promise} />,
      promise,
    );
    expect(screen.getByTestId("org-switcher")).toHaveAttribute(
      "data-current",
      "acme",
    );
  });

  it("passes available orgs count to OrgSwitcher", async () => {
    const promise = makeNavPromise({ availableOrgs: orgs });
    await renderSuspended(
      <OrgSwitcherSlot org={org} navDataPromise={promise} />,
      promise,
    );
    expect(screen.getByTestId("org-switcher")).toHaveAttribute(
      "data-orgs-count",
      "1",
    );
  });
});

// ---------------------------------------------------------------------------
// WorkspaceSwitcherSlot
// ---------------------------------------------------------------------------

describe("WorkspaceSwitcherSlot — no current workspace", () => {
  it("renders nothing when workspace is undefined and no matching slug in availableWorkspaces", async () => {
    const promise = makeNavPromise({ availableWorkspaces: [] });
    await renderSuspended(
      <WorkspaceSwitcherSlot
        org={org}
        workspace={undefined}
        navDataPromise={promise}
      />,
      promise,
    );
    expect(screen.queryByTestId("workspace-switcher")).not.toBeInTheDocument();
  });
});

describe("WorkspaceSwitcherSlot — with current workspace", () => {
  it("renders WorkspaceSwitcher when workspace prop is provided", async () => {
    const promise = makeNavPromise({ availableWorkspaces: workspaces });
    await renderSuspended(
      <WorkspaceSwitcherSlot
        org={org}
        workspace={workspace}
        navDataPromise={promise}
      />,
      promise,
    );
    expect(screen.getByTestId("workspace-switcher")).toBeInTheDocument();
  });

  it("passes current workspace slug to WorkspaceSwitcher", async () => {
    const promise = makeNavPromise({ availableWorkspaces: workspaces });
    await renderSuspended(
      <WorkspaceSwitcherSlot
        org={org}
        workspace={workspace}
        navDataPromise={promise}
      />,
      promise,
    );
    expect(screen.getByTestId("workspace-switcher")).toHaveAttribute(
      "data-current",
      "prod",
    );
  });
});

// ---------------------------------------------------------------------------
// BalanceSlot
// ---------------------------------------------------------------------------

describe("BalanceSlot — no balance", () => {
  it("renders nothing when balance is null", async () => {
    const promise = makeNavPromise({ balance: null });
    await renderSuspended(
      <BalanceSlot orgSlug="acme" navDataPromise={promise} />,
      promise,
    );
    expect(screen.queryByTestId("balance-pill")).not.toBeInTheDocument();
  });
});

describe("BalanceSlot — with balance", () => {
  it("renders BalancePill when balance data is present", async () => {
    const promise = makeNavPromise({ balance: { cents: 500, low: false } });
    await renderSuspended(
      <BalanceSlot orgSlug="acme" navDataPromise={promise} />,
      promise,
    );
    expect(screen.getByTestId("balance-pill")).toBeInTheDocument();
  });

  it("passes orgSlug and balanceCents to BalancePill", async () => {
    const promise = makeNavPromise({ balance: { cents: 1250, low: true } });
    await renderSuspended(
      <BalanceSlot orgSlug="acme" navDataPromise={promise} />,
      promise,
    );
    const pill = screen.getByTestId("balance-pill");
    expect(pill).toHaveAttribute("data-org", "acme");
    expect(pill).toHaveAttribute("data-cents", "1250");
  });
});
