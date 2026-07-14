// @vitest-environment jsdom
/**
 * page.test.tsx — the node-detail page's admin render-gate.
 *
 * The mutation server actions re-assert admin server-side (see actions.test.ts),
 * so this covers the complementary UI gate: the NodeAdminActions panel must be
 * rendered ONLY for owners/admins, and hidden for a plain member/viewer. The
 * page is an async Server Component, so it's awaited directly and the resolved
 * element passed to render(); NodeNeighbors/NodeAdminActions are stubbed (they
 * have their own tests).
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const {
  mockInvoke,
  mockRunInTenantScope,
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockGetOrgRole,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockGetOrgRole: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
  getOrgRole: mockGetOrgRole,
}));
vi.mock("./_sections/node-neighbors", () => ({
  NodeNeighbors: () => <div data-testid="node-neighbors" />,
}));
vi.mock("./node-admin-actions", () => ({
  NodeAdminActions: () => <div data-testid="node-admin-actions" />,
}));

import KnowledgeNodePage from "./page";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  mockRunInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
  mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
  mockResolveOrg.mockResolvedValue({ id: "org-1" });
  mockResolveWorkspace.mockResolvedValue({ id: "ws-1" });
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockInvoke.mockImplementation(async (name: string) => {
    if (name === "get_node") {
      return {
        node: {
          nodeId: "kn_1",
          displayName: "Reactor",
          label: "Component",
          description: null,
          properties: {},
          createdAt: null,
          updatedAt: null,
        },
      };
    }
    if (name === "get_node_labels") return { labels: [] };
    return {};
  });
});

const params = Promise.resolve({ orgSlug: "acme", workspaceSlug: "main", nodeId: "kn_1" });

describe("KnowledgeNodePage — admin render-gate", () => {
  it("renders the admin actions panel for an owner/admin", async () => {
    mockGetOrgRole.mockResolvedValue("admin");
    render(await KnowledgeNodePage({ params }));
    expect(screen.getByTestId("node-admin-actions")).toBeInTheDocument();
  });

  it("hides the admin actions panel for a non-admin member", async () => {
    mockGetOrgRole.mockResolvedValue("member");
    render(await KnowledgeNodePage({ params }));
    expect(screen.queryByTestId("node-admin-actions")).not.toBeInTheDocument();
    // The rest of the page still renders (neighbors section is always present).
    expect(screen.getByTestId("node-neighbors")).toBeInTheDocument();
  });
});
