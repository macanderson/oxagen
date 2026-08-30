// @vitest-environment jsdom
/**
 * workspace-members-panel.test.tsx — tests for the async WorkspaceMembersPanel
 * Server Component.
 *
 * WorkspaceMembersPanel is an async function component (no hooks) — it is
 * invoked directly (`await WorkspaceMembersPanel(props)`) and the resolved
 * element is rendered with RTL, the standard pattern for testing an RSC-shaped
 * async component outside the Next.js runtime.
 *
 * Covers:
 *   (a) Renders the member list with workspace + org role badges.
 *   (b) Marks the viewer's own row with "(you)".
 *   (c) Empty roster → "No members in this workspace yet."
 *   (d) DB failure degrades to an inline ErrorState notice instead of throwing
 *       (docs/web-app-2.0/workspace/settings/general/spec.md fix-in-place item).
 */

import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

const { mockWithTenantDb, mockRunInTenantScope, dbState } = vi.hoisted(() => {
  const dbState: {
    membersRows: Array<{
      publicId: string;
      userId: string;
      wsRole: string;
      email: string;
      displayName: string | null;
    }>;
    orgRolesRows: Array<{ userId: string; orgRole: string }>;
    throwOnMembers: boolean;
    // The component issues the members query and the org-roles query as TWO
    // separate withTenantDb() calls, so this counter must persist across them.
    callIndex: number;
  } = {
    membersRows: [],
    orgRolesRows: [],
    throwOnMembers: false,
    callIndex: 0,
  };

  const mockWithTenantDb = vi.fn((fn: (tx: unknown) => unknown) => {
    const tx = {
      select: vi.fn(() => {
        dbState.callIndex += 1;
        if (dbState.callIndex === 1) {
          if (dbState.throwOnMembers) throw new Error("db down");
          return {
            from: vi.fn(() => ({
              innerJoin: vi.fn(() => ({
                where: vi.fn(() => Promise.resolve(dbState.membersRows)),
              })),
            })),
          };
        }
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve(dbState.orgRolesRows)),
          })),
        };
      }),
    };
    return fn(tx);
  });
  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) =>
    fn(),
  );

  return { mockWithTenantDb, mockRunInTenantScope, dbState };
});

vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mockWithTenantDb,
  };
});

import { WorkspaceMembersPanel } from "./workspace-members-panel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  dbState.membersRows = [];
  dbState.orgRolesRows = [];
  dbState.throwOnMembers = false;
  dbState.callIndex = 0;
});

const BASE_PROPS = {
  orgId: "org-1",
  workspaceId: "ws-1",
  workspaceName: "Research",
  orgSlug: "acme",
  viewerUserId: "user-1",
};

describe("WorkspaceMembersPanel", () => {
  it("renders each member with workspace + org role badges", async () => {
    dbState.membersRows = [
      {
        publicId: "wsu-1",
        userId: "user-1",
        wsRole: "owner",
        email: "me@acme.com",
        displayName: "Me",
      },
      {
        publicId: "wsu-2",
        userId: "user-2",
        wsRole: "member",
        email: "you@acme.com",
        displayName: null,
      },
    ];
    dbState.orgRolesRows = [
      { userId: "user-1", orgRole: "admin" },
      { userId: "user-2", orgRole: "member" },
    ];

    const element = await WorkspaceMembersPanel(BASE_PROPS);
    render(element);

    expect(screen.getByText("Me")).toBeInTheDocument();
    // Second member has no displayName → falls back to email.
    expect(
      screen.getByText("you@acme.com", { selector: "span.font-medium" }),
    ).toBeInTheDocument();
    expect(screen.getByText("org: admin")).toBeInTheDocument();
    expect(screen.getByText("ws: owner")).toBeInTheDocument();
    expect(screen.getByText("ws: member")).toBeInTheDocument();
  });

  it("marks the viewer's own row with (you)", async () => {
    dbState.membersRows = [
      {
        publicId: "wsu-1",
        userId: "user-1",
        wsRole: "owner",
        email: "me@acme.com",
        displayName: "Me",
      },
    ];
    dbState.orgRolesRows = [{ userId: "user-1", orgRole: "owner" }];

    const element = await WorkspaceMembersPanel(BASE_PROPS);
    render(element);

    expect(screen.getByText("(you)")).toBeInTheDocument();
  });

  it("shows the empty-roster message when there are no members", async () => {
    dbState.membersRows = [];

    const element = await WorkspaceMembersPanel(BASE_PROPS);
    render(element);

    expect(
      screen.getByText("No members in this workspace yet."),
    ).toBeInTheDocument();
  });

  it("degrades to an inline ErrorState notice when the members read fails", async () => {
    dbState.throwOnMembers = true;

    const element = await WorkspaceMembersPanel(BASE_PROPS);
    render(element);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByText("Couldn't load workspace members"),
    ).toBeInTheDocument();
    // Never throws — no crash, so the surrounding General/Members shell stays intact.
  });

  it("links to org-level member management", async () => {
    dbState.membersRows = [];

    const element = await WorkspaceMembersPanel(BASE_PROPS);
    render(element);

    const link = screen.getByRole("link", { name: "Organization Members" });
    expect(link).toHaveAttribute("href", "/acme/members");
  });
});
