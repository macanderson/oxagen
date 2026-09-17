import { beforeEach, describe, expect, it, vi } from "vitest";
import { repositoryMainGet } from "@oxagen/oxagen/contracts/repository.main.get";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(async (c: { userId: string | null }) => c.userId),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { createMainRepositoryGetHandler } from "./repository.main.get";

const BOUND_AT = new Date("2026-09-15T12:06:00.000Z");

const BINDING_ROW = {
  bindingId: "rpb_0123456789abcdef",
  owner: "acme",
  name: "widgets",
  fullName: "acme/widgets",
  defaultRef: "main",
  boundAt: BOUND_AT,
};

const URLS = {
  installUrl: "https://github.com/apps/oxagen/installations/new?state=abc.def",
  manageUrl: "https://github.com/apps/oxagen/installations/new",
};

/**
 * The handler makes two reads through `withTenantDb`, in this order: the
 * binding head joined to its binding, then the workspace's GitHub connection.
 * Each gets its own chain shape.
 */
function wire(opts: {
  binding?: typeof BINDING_ROW | null;
  connections?: unknown[];
}): void {
  const bindingRows = opts.binding ? [opts.binding] : [];
  mocks.withTenantDb
    .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({ limit: async () => bindingRows }),
            }),
          }),
        }),
      }),
    )
    .mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({ where: async () => opts.connections ?? [] }),
        }),
      }),
    );
}

function handler(urls: typeof URLS | null = URLS) {
  return createMainRepositoryGetHandler({ githubUrls: () => urls });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
});

describe("get_main_repository", () => {
  it("refuses a caller who is not an org Owner or Admin, before reading anything", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(new Error("org_role_required"));
    await expect(handler()({}, makeCTX())).rejects.toThrow(
      "org_role_required",
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("checks the role against the acting user the context resolves (INV-29)", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_acting");
    wire({ binding: null });
    await handler()({}, makeCTX({ userId: "u_session" }));
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_acting" }),
      { org: ["Owner", "Admin"] },
    );
  });

  it("answers the bound repository, connected, with both signed doors", async () => {
    wire({
      binding: BINDING_ROW,
      connections: [
        {
          id: "conn-uuid",
          publicId: "con_ABC",
          status: "connected",
          deliveryConfig: { installationId: "555" },
        },
      ],
    });

    const out = await handler()({}, makeCTX());

    expect(out).toEqual({
      repository: {
        bindingId: "rpb_0123456789abcdef",
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets",
        defaultRef: "main",
        // Derived from the full name: the bind persists no html url.
        htmlUrl: "https://github.com/acme/widgets",
        boundAt: "2026-09-15T12:06:00.000Z",
      },
      github: { connected: true, ...URLS },
    });
    expect(() => repositoryMainGet.output.parse(out)).not.toThrow();
  });

  it("never ships the installation id, by any name", async () => {
    wire({
      binding: BINDING_ROW,
      connections: [
        {
          id: "conn-uuid",
          publicId: "con_ABC",
          status: "connected",
          deliveryConfig: { installationId: "555" },
        },
      ],
    });
    const out = await handler()({}, makeCTX());
    expect(JSON.stringify(out)).not.toContain("555");
    expect(JSON.stringify(out)).not.toContain("conn-uuid");
  });

  it("answers a provisional workspace: nothing bound, nothing connected, but a door", async () => {
    wire({ binding: null, connections: [] });

    const out = await handler()({}, makeCTX());

    expect(out).toEqual({
      repository: null,
      github: { connected: false, ...URLS },
    });
    expect(() => repositoryMainGet.output.parse(out)).not.toThrow();
  });

  it("reports not-connected when the only GitHub connection carries no installation", async () => {
    wire({
      binding: null,
      connections: [
        {
          id: "conn-uuid",
          publicId: "con_ABC",
          status: "pending_setup",
          deliveryConfig: { owner: "acme" },
        },
      ],
    });
    const out = await handler()({}, makeCTX());
    // Exactly the state bind_main_repository refuses as github_not_connected.
    expect(out.github.connected).toBe(false);
  });

  it("takes the first connection that carries an installation, past ones that do not", async () => {
    wire({
      binding: null,
      connections: [
        { id: "a", publicId: "con_A", status: "error", deliveryConfig: null },
        {
          id: "b",
          publicId: "con_B",
          status: "connected",
          deliveryConfig: { installationId: 777 },
        },
      ],
    });
    const out = await handler()({}, makeCTX());
    expect(out.github.connected).toBe(true);
  });

  it("answers null URLs, not an error, when the deployment has no GitHub App", async () => {
    wire({ binding: BINDING_ROW, connections: [] });

    const out = await handler(null)({}, makeCTX());

    // The dialog must still render: the repository already bound is worth
    // showing even where nobody can install anything.
    expect(out.github).toEqual({
      connected: false,
      installUrl: null,
      manageUrl: null,
    });
    expect(out.repository?.fullName).toBe("acme/widgets");
    expect(() => repositoryMainGet.output.parse(out)).not.toThrow();
  });

  it("builds the URLs for the calling org and workspace", async () => {
    wire({ binding: null, connections: [] });
    const githubUrls = vi.fn(() => URLS);
    await createMainRepositoryGetHandler({ githubUrls })(
      {},
      makeCTX({ orgId: "org-9", workspaceId: "ws-9" }),
    );
    expect(githubUrls).toHaveBeenCalledWith({
      orgId: "org-9",
      workspaceId: "ws-9",
    });
  });

  it("makes no GitHub API call — a settings read renders while GitHub is down", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    wire({ binding: BINDING_ROW, connections: [] });
    await handler()({}, makeCTX());
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
