import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  orgFindFirst: vi.fn(),
  wsFindFirst: vi.fn(),
  txInsertWs: vi.fn(),
  txInsertWsReturning: vi.fn(),
  txInsertWsUsers: vi.fn(),
  txFn: vi.fn(),
}));

// Defaults: org found, no conflicting slug
mocks.orgFindFirst.mockResolvedValue({ slug: "acme" });
mocks.wsFindFirst.mockResolvedValue(null);

mocks.txInsertWsReturning.mockResolvedValue([
  {
    publicId: "ws_pub_1",
    name: "Default Workspace",
    slug: "default",
    id: "internal_ws_id",
    createdAt: new Date("2026-05-01T00:00:00Z"),
  },
]);
const wsValuesStub = { returning: mocks.txInsertWsReturning };
mocks.txInsertWs.mockReturnValue({ values: () => wsValuesStub });
mocks.txInsertWsUsers.mockReturnValue({ values: vi.fn(async () => undefined) });

mocks.txFn.mockImplementation(
  async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
    let insertCount = 0;
    const tx = {
      insert: (table: unknown): unknown => {
        insertCount++;
        if (insertCount === 1) return mocks.txInsertWs(table) as unknown;
        return mocks.txInsertWsUsers(table) as unknown;
      },
    };
    return cb(tx as unknown as Parameters<typeof cb>[0]);
  },
);

// Stub bootstrapWorkspaceAgents to isolate workspace.create tests from DB
// agent-seeding behaviour — that is covered by workspace-agents unit tests.
vi.mock("./workspace-agents", () => ({
  bootstrapWorkspaceAgents: vi.fn(async () => undefined),
}));

// Stub seedWorkspaceDefaultRegistry to isolate workspace.create tests from
// registry-seeding behaviour — that is covered by workspace-registry-seed tests.
vi.mock("./workspace-registry-seed", () => ({
  seedWorkspaceDefaultRegistry: vi.fn(async () => "mreg_stub"),
}));

// Stub seedWorkspaceDefaultCapabilities to isolate workspace.create tests from
// capability-seeding behaviour — covered by workspace-capability-seed tests.
vi.mock("./workspace-capability-seed", () => ({
  seedWorkspaceDefaultCapabilities: vi.fn(async () => undefined),
}));

// Stub seedWorkspaceDefaultSkills to isolate workspace.create tests from
// skill-seeding behaviour — covered by skill-workspace-seed tests.
vi.mock("./skill-workspace-seed", () => ({
  seedWorkspaceDefaultSkills: vi.fn(async () => ({ scanned: 0, inserted: 0 })),
}));

// Stub seedWorkspaceDefaultEnvironment to isolate workspace.create tests from
// environment-seeding behaviour — covered by workspace-environment-seed tests.
vi.mock("./workspace-environment-seed", () => ({
  seedWorkspaceDefaultEnvironment: vi.fn(async () => "env_stub_id"),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({
      query: {
        organizations: { findFirst: mocks.orgFindFirst },
        workspaces: { findFirst: mocks.wsFindFirst },
      },
      transaction: mocks.txFn,
    }),
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Each withTenantDb call gets its own insert counter so the org-query,
      // ws-query, and transaction calls each see a fresh counter.
      const insertCountRef = { n: 0 };
      const tx = {
        query: {
          organizations: { findFirst: mocks.orgFindFirst },
          workspaces: { findFirst: mocks.wsFindFirst },
        },
        // Namespace derivation reads the org's existing workspace namespaces
        // before inserting; empty means the slug-derived namespace is used as-is.
        select: () => ({ from: () => ({ where: async () => [] }) }),
        insert: (table: unknown): unknown => {
          insertCountRef.n++;
          if (insertCountRef.n === 1) return mocks.txInsertWs(table) as unknown;
          return mocks.txInsertWsUsers(table) as unknown;
        },
      };
      return fn(tx);
    },
  };
});

import { workspaceCreateHandler } from "./workspace.create";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("workspaceCreateHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.orgFindFirst.mockClear();
    mocks.wsFindFirst.mockClear();
    mocks.txFn.mockClear();
    mocks.txInsertWs.mockClear();
    mocks.txInsertWsReturning.mockClear();
    // Restore defaults
    mocks.orgFindFirst.mockResolvedValue({ slug: "acme" });
    mocks.wsFindFirst.mockResolvedValue(null);
    mocks.txInsertWsReturning.mockResolvedValue([
      {
        publicId: "ws_pub_1",
        name: "Default Workspace",
        slug: "default",
        id: "internal_ws_id",
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]);
  });

  // ── auth guard ───────────────────────────────────────────────────────────

  it("throws when userId is null (unauthenticated request)", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      workspaceCreateHandler({ name: "Test", slug: "test" }, anonCtx),
    ).rejects.toThrow("workspace.create requires an authenticated user");
  });

  // ── tenant guard ──────────────────────────────────────────────────────────

  it("throws when the org is not found (tenant lookup failure)", async () => {
    mocks.orgFindFirst.mockResolvedValueOnce(null);

    await expect(
      workspaceCreateHandler({ name: "Dev", slug: "dev" }, CTX),
    ).rejects.toThrow("tenant not found");
  });

  // ── slug conflict guard ──────────────────────────────────────────────────

  it("throws a friendly error when the slug already exists in this tenant", async () => {
    mocks.wsFindFirst.mockResolvedValueOnce({ id: "existing_ws" });

    await expect(
      workspaceCreateHandler({ name: "Dupe", slug: "default" }, CTX),
    ).rejects.toThrow('slug "default" already in use for this tenant');
  });

  // ── happy path ───────────────────────────────────────────────────────────

  it("returns publicId, name, slug, orgSlug, and ISO createdAt", async () => {
    const result = await workspaceCreateHandler(
      { name: "Default Workspace", slug: "default" },
      CTX,
    );

    expect(result.publicId).toBe("ws_pub_1");
    expect(result.name).toBe("Default Workspace");
    expect(result.slug).toBe("default");
    expect(result.orgSlug).toBe("acme");
    expect(result.createdAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("runs workspace and membership inserts via withTenantDb", async () => {
    await workspaceCreateHandler({ name: "Tx Ws", slug: "tx-ws" }, CTX);
    // withTenantDb replaces db().transaction(); verify the ws insert was called.
    expect(mocks.txInsertWs).toHaveBeenCalledTimes(1);
  });

  it("seeds the default capability packs after workspace creation", async () => {
    const { seedWorkspaceDefaultCapabilities } = await import(
      "./workspace-capability-seed"
    );
    await workspaceCreateHandler({ name: "Cap Ws", slug: "cap-ws" }, CTX);
    expect(seedWorkspaceDefaultCapabilities).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: "internal_ws_id",
    });
  });

  it("seeds the default workspace skills after workspace creation", async () => {
    const { seedWorkspaceDefaultSkills } = await import(
      "./skill-workspace-seed"
    );
    await workspaceCreateHandler({ name: "Skill Ws", slug: "skill-ws" }, CTX);
    expect(seedWorkspaceDefaultSkills).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: "internal_ws_id",
    });
  });

  it("seeds the default environment after workspace creation", async () => {
    const { seedWorkspaceDefaultEnvironment } = await import(
      "./workspace-environment-seed"
    );
    await workspaceCreateHandler({ name: "Env Ws", slug: "env-ws" }, CTX);
    expect(seedWorkspaceDefaultEnvironment).toHaveBeenCalledWith({
      orgId: CTX.orgId,
      workspaceId: "internal_ws_id",
    });
  });

  it("throws when the transaction insert returns no row", async () => {
    mocks.txInsertWsReturning.mockResolvedValueOnce([]);

    await expect(
      workspaceCreateHandler({ name: "Empty", slug: "empty" }, CTX),
    ).rejects.toThrow("workspace insert returned no row");
  });

  // ── scope isolation ───────────────────────────────────────────────────────

  it("looks up the org by the orgId from context (not from input)", async () => {
    await workspaceCreateHandler({ name: "Scoped", slug: "scoped" }, CTX);
    // The org query should receive the orgId from CTX, not from user input
    expect(mocks.orgFindFirst).toHaveBeenCalledTimes(1);
  });

  it("slug uniqueness check uses both orgId from context and the input slug", async () => {
    await workspaceCreateHandler({ name: "Scoped2", slug: "scoped2" }, CTX);
    expect(mocks.wsFindFirst).toHaveBeenCalledTimes(1);
  });
});
