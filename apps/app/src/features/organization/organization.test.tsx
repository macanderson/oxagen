// @vitest-environment jsdom
// The Organization page bodies (organization.tsx): which tab each `?tab=`
// value draws inside the frame, and which reads each tab makes of its own.
// Workspaces reads `org.workspaceFacts` only inside a workspace the viewer may
// enter, each after `requireViewer(org, ws)` has checked the membership
// (INV-15), so a workspace the viewer does not belong to and an archived one
// are never read. Data plane, Roles and Model funding make their one read
// inside the frame, so a viewer the frame refuses never reaches it.
import { cleanup, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberList, WorkspaceFacts } from "@/data/contracts/org";
import { readOk } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { IntlProvider, translator } from "@/test/intl";

const { getSession, requireViewer } = vi.hoisted(() => ({
  getSession: vi.fn(),
  requireViewer: vi.fn(),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(translator(namespace)),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/acme",
}));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));
vi.mock("./actions", () => ({
  createRole: vi.fn(),
  setRolePermissions: vi.fn(),
  deleteRole: vi.fn(),
  createWorkspace: vi.fn(),
  editWorkspace: vi.fn(),
  archiveWorkspace: vi.fn(),
  changeMemberRole: vi.fn(),
  removeOrgMember: vi.fn(),
  sendInvitation: vi.fn(),
  resendInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
}));
vi.mock("./api-key-actions", () => ({
  createApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));
vi.mock("./model-funding-actions", () => ({
  testModelKey: vi.fn(),
  saveModelKey: vi.fn(),
  removeModelKey: vi.fn(),
}));
vi.mock("./cost-center-actions", () => ({
  createCostCenter: vi.fn(),
  deleteCostCenter: vi.fn(),
  setWorkspaceCostCenter: vi.fn(),
}));
vi.mock("./sso-actions", () => ({
  createSsoProvider: vi.fn(),
  updateSsoProvider: vi.fn(),
  deleteSsoProvider: vi.fn(),
  verifySsoDomain: vi.fn(),
  setSsoRequired: vi.fn(),
  setSsoGroupRoles: vi.fn(),
  createScimToken: vi.fn(),
  rotateScimToken: vi.fn(),
  revokeScimToken: vi.fn(),
}));
vi.mock("./workspace-reads", () => ({ readRepositoryChoices: vi.fn() }));
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({
  systemLookups: { mfaPolicy: () => Promise.resolve(null) },
}));

const { OrgCtx, WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  dataPlane,
  orgSource,
  roleCatalog,
  roleRow,
  ssoSettings,
  workspaceRow,
} = await import("./organization.builders");
const { OrganizationFrame } = await import("./frame");
const {
  Organization,
  OrganizationApiKeys,
  OrganizationModelFunding,
  OrganizationRoles,
  parseOrganizationTab,
} = await import("./organization");

const ORG_FIELDS = {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
};

function ctxFor(role: OrgRole) {
  return unsafeMint(OrgCtx, { ...ORG_FIELDS, orgRole: role });
}

/** The viewer requireViewer resolves inside core-platform. */
const coreCtx = unsafeMint(WsCtx, {
  ...ORG_FIELDS,
  orgRole: "owner",
  workspaceId: "7a000000-0000-4000-8000-0000000000c3",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "owner",
});

/** core-platform the viewer belongs to, finops they do not, legacy archived. */
const WORKSPACES = {
  workspaces: [
    workspaceRow(),
    workspaceRow({
      id: "wrk_1b2c3d4e5f6g7h8j9k0m1n",
      slug: "finops",
      namespace: "finops",
      name: "FinOps",
      role: null,
    }),
    workspaceRow({
      id: "wrk_2c3d4e5f6g7h8j9k0m1n2p",
      slug: "legacy",
      namespace: "legacy",
      name: "Legacy",
      archivedAt: "2026-06-01T00:00:00.000Z",
    }),
  ],
};

const CORE_FACTS: WorkspaceFacts = {
  repositories: [
    { role: "main", fullName: "acme/platform", defaultRef: "main" },
  ],
  agents: 64,
  archiveBlockers: { count: 0, more: false },
};

const ROSTER: MemberList = {
  members: [
    {
      id: "usr_7k2m9q4x8r1t5v3w6y0z2a",
      name: "Marcus Bell",
      email: "marcus@acme.example",
      role: "owner",
      joinedAt: "2026-03-02T09:15:00.000Z",
    },
  ],
  invitations: [
    {
      id: "invi_4n5p6q7r8s9t0v1w2x3y4z",
      email: "dana@acme.example",
      role: "admin",
      invitedAt: "2026-09-10T12:00:00.000Z",
      expiresAt: null,
    },
  ],
};

function sourceWith(extra: Parameters<typeof orgSource>[0] = {}) {
  return orgSource({
    members: readOk(ROSTER),
    roles: readOk(roleCatalog({ roles: [roleRow()] })),
    workspaces: readOk(WORKSPACES),
    ...extra,
  });
}

/** The route's element rendered the way the route renders it: through the frame. */
async function renderPage(
  page: ReactElement<ComponentProps<typeof OrganizationFrame>>,
) {
  return render(
    <IntlProvider>{await OrganizationFrame(page.props)}</IntlProvider>,
  );
}

beforeEach(() => {
  getSession.mockResolvedValue({
    user: { name: "Marcus Bell", email: "marcus@acme.example" },
  });
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(coreCtx);
});
afterEach(cleanup);

describe("parseOrganizationTab", () => {
  it.each(["people", "invitations", "workspaces", "dataPlane", "costCenters"])(
    "names the %s tab",
    (tab) => {
      expect(parseOrganizationTab(tab)).toBe(tab);
    },
  );

  it("reads the first value of a repeated tab", () => {
    expect(parseOrganizationTab(["workspaces", "dataPlane"])).toBe(
      "workspaces",
    );
  });

  it.each([undefined, "", "roles", "apiKeys", "DataPlane", "data-plane"])(
    "falls back to People for %j (negative)",
    (value) => {
      expect(parseOrganizationTab(value)).toBe("people");
    },
  );
});

describe("Organization", () => {
  it("draws People by default and makes no read of a tab's own", async () => {
    const { source, calls } = sourceWith();
    await renderPage(
      Organization({ ctx: ctxFor("owner"), source, tab: "people" }),
    );

    expect(screen.getByRole("table", { name: "People" })).toHaveTextContent(
      "Marcus Bell",
    );
    expect(calls.workspaceFacts).toEqual([]);
    expect(calls.dataPlane).toEqual([]);
    expect(calls.costCenters).toEqual([]);
    expect(requireViewer).not.toHaveBeenCalled();
  });

  it("draws the pending invitations on Invitations", async () => {
    const { source } = sourceWith();
    await renderPage(
      Organization({ ctx: ctxFor("owner"), source, tab: "invitations" }),
    );

    expect(
      screen.getByRole("table", { name: "Pending invitations" }),
    ).toHaveTextContent("dana@acme.example");
  });

  it("reads the facts of each workspace the viewer may enter, through its own viewer, and of no other", async () => {
    const { source, calls } = sourceWith({
      workspaceFacts: { "core-platform": readOk(CORE_FACTS) },
    });
    await renderPage(
      Organization({ ctx: ctxFor("owner"), source, tab: "workspaces" }),
    );

    // Membership is checked for the one live workspace the viewer belongs to.
    expect(requireViewer.mock.calls).toEqual([["acme", "core-platform"]]);
    // The facts read runs in the workspace's viewer, never the org viewer.
    expect(calls.workspaceFacts).toEqual([[coreCtx]]);
    expect(document.body).toHaveTextContent("acme/platform");
  });

  it("reads Data plane inside the frame with the organization viewer", async () => {
    const ctx = ctxFor("admin");
    const { source, calls } = sourceWith({
      dataPlane: readOk(dataPlane({ status: "degraded" })),
    });
    await renderPage(Organization({ ctx, source, tab: "dataPlane" }));

    expect(calls.dataPlane).toEqual([[ctx]]);
    expect(calls.workspaceFacts).toEqual([]);
  });

  it("reads the cost centers on Cost centers", async () => {
    const { source, calls } = sourceWith({
      costCenters: readOk({ costCenters: [] }),
    });
    await renderPage(
      Organization({ ctx: ctxFor("owner"), source, tab: "costCenters" }),
    );

    expect(calls.costCenters).toHaveLength(1);
  });

  it.each(["workspaces", "dataPlane", "costCenters"] as const)(
    "makes no %s read for a viewer the frame refuses (negative)",
    async (tab) => {
      const { source, calls } = sourceWith();
      await renderPage(Organization({ ctx: ctxFor("member"), source, tab }));

      expect(requireViewer).not.toHaveBeenCalled();
      expect(calls.workspaceFacts).toEqual([]);
      expect(calls.dataPlane).toEqual([]);
      expect(calls.costCenters).toEqual([]);
    },
  );
});

describe("OrganizationRoles", () => {
  it("reads the SSO group mappings beside the roles", async () => {
    const ctx = ctxFor("owner");
    const { source, calls } = sourceWith({ sso: readOk(ssoSettings()) });
    await renderPage(OrganizationRoles({ ctx, source }));

    expect(calls.sso).toEqual([[ctx]]);
  });

  it("reads no SSO settings for a viewer the frame refuses (negative)", async () => {
    const { source, calls } = sourceWith();
    await renderPage(OrganizationRoles({ ctx: ctxFor("member"), source }));

    expect(calls.sso).toEqual([]);
  });
});

describe("OrganizationModelFunding", () => {
  it("reads no model credential for a viewer the frame refuses (negative)", async () => {
    const { source, calls } = sourceWith();
    await renderPage(
      OrganizationModelFunding({ ctx: ctxFor("member"), source }),
    );

    expect(calls.modelCredential).toEqual([]);
  });
});

describe("OrganizationApiKeys", () => {
  it("reads the keys through the workspace viewer it is handed, not the organization one", async () => {
    const ctx = ctxFor("owner");
    const { source, calls } = sourceWith({ apiKeys: readOk([]) });
    await renderPage(
      OrganizationApiKeys({
        ctx,
        keysCtx: coreCtx,
        source,
        workspaces: readOk(WORKSPACES),
        view: { workspace: "core-platform", show: "active" },
      }),
    );

    expect(calls.apiKeys).toEqual([[coreCtx]]);
  });
});
