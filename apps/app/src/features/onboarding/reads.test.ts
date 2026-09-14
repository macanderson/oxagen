import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeQuery } from "../auth/test-query";

const wheres: string[] = [];
const findOrg = vi.fn<(o: unknown) => unknown>();
const findWorkspace = vi.fn<(o: unknown) => unknown>();
const getSession = vi.fn();
// The live lookups requireViewer/resolveViewer run: stubbed per test so the real
// resolution (org → role → workspace → workspace membership → MFA → slug) decides.
const lookups = {
  orgBySlug: vi.fn(),
  orgBySlugHistory: vi.fn(),
  workspaceBySlug: vi.fn(),
  workspaceBySlugHistory: vi.fn(),
  orgRole: vi.fn(),
  isWorkspaceMember: vi.fn(),
  mfaPolicy: vi.fn(),
  twoFactorEnabled: vi.fn(),
};

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: () => {
    throw new Error("NEXT_REDIRECT");
  },
  permanentRedirect: () => {
    throw new Error("NEXT_PERMANENT_REDIRECT");
  },
}));
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({ liveTenancyLookups: lookups }));
// requireViewer defers its clock read behind connection(), which needs a request scope.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: () => Promise.resolve(),
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));
// Only the onboarding port is under test: the real live source loads every live
// adapter, whose @oxagen/database imports this file's partial mock does not carry.
vi.mock("@/data/adapters/live", async () => ({
  liveSource: {
    onboarding: (await import("@/data/adapters/live/onboarding"))
      .liveOnboarding,
  },
}));
vi.mock("@oxagen/database", () => ({
  withSystemDb: (fn: (tx: unknown) => unknown) =>
    fn({
      query: {
        organizations: {
          findFirst: (o: Parameters<typeof describeQuery>[0]) => {
            wheres.push(describeQuery(o).where ?? "");
            return findOrg(o);
          },
        },
        workspaces: {
          findFirst: (o: Parameters<typeof describeQuery>[0]) => {
            wheres.push(describeQuery(o).where ?? "");
            return findWorkspace(o);
          },
        },
      },
    }),
}));

const reads = await import("./reads");
const ORG_ID = "7a000000-0000-4000-8000-0000000000a1";
const WS_ID = "7a000000-0000-4000-8000-0000000000b1";
const sessionUser = {
  id: "user-1",
  email: "priya@acme.example",
  name: "Priya Raman",
  image: null,
};

/** Priya: a member of Acme, and of core-platform unless a test says otherwise. */
function stubLiveTenancy() {
  getSession.mockResolvedValue({ user: sessionUser });
  lookups.orgBySlug.mockImplementation((slug: string) =>
    Promise.resolve(
      slug === "acme"
        ? { id: ORG_ID, publicId: "org_a", slug, name: "Acme Robotics" }
        : null,
    ),
  );
  lookups.orgBySlugHistory.mockResolvedValue(null);
  lookups.workspaceBySlug.mockImplementation((orgId: string, slug: string) =>
    Promise.resolve(
      slug === "core-platform"
        ? { id: WS_ID, publicId: "wks_c", orgId, slug, name: "Core platform" }
        : null,
    ),
  );
  lookups.workspaceBySlugHistory.mockResolvedValue(null);
  lookups.orgRole.mockResolvedValue("member");
  lookups.isWorkspaceMember.mockResolvedValue(true);
  lookups.mfaPolicy.mockResolvedValue(null);
  lookups.twoFactorEnabled.mockResolvedValue(false);
}

beforeEach(() => {
  wheres.length = 0;
  findOrg.mockReset();
  findWorkspace.mockReset();
  getSession.mockReset();
  for (const fn of Object.values(lookups)) fn.mockReset();
});

const NOT_FOUND = {
  ok: false,
  reason: "error",
  code: "workspace_not_found",
  status: 404,
};

describe("loadFlowScope", () => {
  it("resolves a workspace the user is a member of, reading namespaces by the admitted ids", async () => {
    stubLiveTenancy();
    findOrg.mockResolvedValue({ namespace: "acme" });
    findWorkspace.mockResolvedValue({ namespace: "core" });
    const read = await reads.loadFlowScope("acme", "core-platform");
    expect(read).toEqual({
      ok: true,
      value: {
        org: { slug: "acme", name: "Acme Robotics", namespace: "acme" },
        ws: { slug: "core-platform", name: "Core platform", namespace: "core" },
        operator: { name: "Priya Raman", email: "priya@acme.example" },
        tenant: { orgId: ORG_ID, workspaceId: WS_ID },
      },
    });
    expect(lookups.isWorkspaceMember).toHaveBeenCalledWith(WS_ID, "user-1");
    expect(wheres).toEqual([
      `and(eq(col:id,${ORG_ID}),ne(col:status,deleted))`,
      `and(eq(col:orgId,${ORG_ID}),eq(col:id,${WS_ID}))`,
    ]);
  });

  it("an org member with no workspace_users row is not found, and no namespace is read", async () => {
    stubLiveTenancy();
    lookups.isWorkspaceMember.mockResolvedValue(false);
    expect(await reads.loadFlowScope("acme", "core-platform")).toEqual(
      NOT_FOUND,
    );
    expect(findOrg).not.toHaveBeenCalled();
    expect(findWorkspace).not.toHaveBeenCalled();
  });

  it("a non-member of the org is not found before the workspace is looked up", async () => {
    stubLiveTenancy();
    lookups.orgRole.mockResolvedValue(null);
    expect(await reads.loadFlowScope("acme", "core-platform")).toEqual(
      NOT_FOUND,
    );
    expect(lookups.workspaceBySlug).not.toHaveBeenCalled();
    expect(findOrg).not.toHaveBeenCalled();
  });

  it("signed out, MFA overdue, or a historical slug all read as not found, never as a throw", async () => {
    stubLiveTenancy();
    getSession.mockResolvedValue(null);
    expect(await reads.loadFlowScope("acme", "core-platform")).toEqual(
      NOT_FOUND,
    );

    stubLiveTenancy();
    lookups.orgRole.mockResolvedValue("owner");
    lookups.mfaPolicy.mockResolvedValue({
      mfaRequired: true,
      mfaGraceHours: 0,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(await reads.loadFlowScope("acme", "core-platform")).toEqual(
      NOT_FOUND,
    );

    stubLiveTenancy();
    lookups.workspaceBySlug.mockResolvedValue(null);
    lookups.workspaceBySlugHistory.mockResolvedValue({
      id: WS_ID,
      publicId: "wks_c",
      orgId: ORG_ID,
      slug: "core-platform",
      name: "Core platform",
    });
    expect(await reads.loadFlowScope("acme", "platform")).toEqual(NOT_FOUND);
    expect(findOrg).not.toHaveBeenCalled();
  });

  it("a workspace whose organization was deleted since is not found", async () => {
    stubLiveTenancy();
    findOrg.mockResolvedValue(undefined);
    expect(await reads.loadFlowScope("acme", "core-platform")).toEqual(
      NOT_FOUND,
    );
    expect(findWorkspace).not.toHaveBeenCalled();
  });

  it("an organization-level viewer has no workspace to register into", async () => {
    const read = await reads.loadViewerFlowScope({
      userId: "user-1",
      user: sessionUser,
      orgRole: "member",
      scope: {
        orgId: ORG_ID,
        workspaceId: "00000000-0000-0000-0000-000000000000",
      },
      org: { id: ORG_ID, slug: "acme", name: "Acme Robotics" },
      ws: null,
    });
    expect(read).toEqual(NOT_FOUND);
    expect(findOrg).not.toHaveBeenCalled();
  });
});

describe("unbacked reads", () => {
  const flow = {
    org: { slug: "acme", name: "Acme", namespace: "acme" },
    ws: { slug: "core-platform", name: "Core platform", namespace: "core" },
    operator: { name: "Marcus Bell", email: "m@a.co" },
    tenant: { orgId: ORG_ID, workspaceId: WS_ID },
  };
  const notBackedG15 = {
    ok: false,
    reason: "not_backed",
    milestone: "M1",
    gap: "G15",
  };

  it("return NotBacked G15", async () => {
    expect(await reads.loadInstallerOffer("gate", flow)).toEqual(notBackedG15);
    expect(
      await reads.loadFirstFrameScript(
        "gate",
        flow,
        "acme.core.x",
        "claude-code",
      ),
    ).toEqual(notBackedG15);
    expect(await reads.loadDetectedRepository(flow)).toEqual(notBackedG15);
    expect(await reads.loadGate("gate", null)).toEqual(notBackedG15);
  });
});
