import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  orgFindFirst: vi.fn(),
  txInsertOrg: vi.fn(),
  txInsertOrgReturning: vi.fn(),
  txInsertOrgUsers: vi.fn(),
  txFn: vi.fn(),
}));

// Default: no existing slug
mocks.orgFindFirst.mockResolvedValue(null);
// Default: tx inserts succeed
mocks.txInsertOrgReturning.mockResolvedValue([
  {
    publicId: "org_pub_1",
    name: "Acme Corp",
    slug: "acme",
    createdAt: new Date("2026-05-01T00:00:00Z"),
    id: "internal_org_id",
  },
]);
// Stub the INSERT chain: insert().values().returning()
const orgValuesStub = { returning: mocks.txInsertOrgReturning };
mocks.txInsertOrg.mockReturnValue({ values: () => orgValuesStub });
// Stub orgUsers insert: insert().values() (no returning)
mocks.txInsertOrgUsers.mockReturnValue({ values: vi.fn(async () => undefined) });

// Transaction mock: runs the callback with a tx object
mocks.txFn.mockImplementation(async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
  // Use a plain counter outside the tx object to avoid self-referential casts.
  let insertCount = 0;
  const tx = {
    insert: (table: unknown): unknown => {
      insertCount++;
      if (insertCount === 1) return mocks.txInsertOrg(table) as unknown;
      return mocks.txInsertOrgUsers(table) as unknown;
    },
  };
  return cb(tx as unknown as Parameters<typeof cb>[0]);
});

vi.mock("@oxagen/database", () => ({
  db: () => ({
    query: {
      organizations: { findFirst: mocks.orgFindFirst },
    },
    transaction: mocks.txFn,
  }),
  schema: {
    organizations: {
      slug: "slug",
      id: "id",
      publicId: "publicId",
      name: "name",
      createdAt: "createdAt",
    },
    orgUsers: {},
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { eq: orig.eq };
});

import { organizationCreateHandler } from "./organization.create.js";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

describe("organizationCreateHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    mocks.orgFindFirst.mockClear();
    mocks.txFn.mockClear();
    mocks.txInsertOrg.mockClear();
    mocks.txInsertOrgReturning.mockClear();
    mocks.txInsertOrgUsers.mockClear();
    // Restore defaults
    mocks.orgFindFirst.mockResolvedValue(null);
    mocks.txInsertOrgReturning.mockResolvedValue([
      {
        publicId: "org_pub_1",
        name: "Acme Corp",
        slug: "acme",
        createdAt: new Date("2026-05-01T00:00:00Z"),
        id: "internal_org_id",
      },
    ]);
  });

  // ── auth guard ───────────────────────────────────────────────────────────

  it("throws when userId is null (unauthenticated request)", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      organizationCreateHandler({ name: "Test", slug: "test", planSlug: "free" }, anonCtx),
    ).rejects.toThrow("organization.create requires an authenticated user");
  });

  // ── slug conflict guard ──────────────────────────────────────────────────

  it("throws a friendly error when the slug already exists (pre-check path)", async () => {
    mocks.orgFindFirst.mockResolvedValueOnce({ id: "existing_id" });

    await expect(
      organizationCreateHandler({ name: "Clone", slug: "acme", planSlug: "free" }, CTX),
    ).rejects.toThrow('slug "acme" already in use');
  });

  it("throws a friendly error on unique_violation (race condition path)", async () => {
    // Pre-check passes (no row), but the insert races and hits the unique index
    mocks.orgFindFirst.mockResolvedValueOnce(null);
    mocks.txFn.mockImplementationOnce(async () => {
      const err = Object.assign(new Error("dup"), { code: "23505" });
      throw err;
    });

    await expect(
      organizationCreateHandler({ name: "Race", slug: "race-slug", planSlug: "free" }, CTX),
    ).rejects.toThrow('slug "race-slug" already in use');
  });

  it("re-throws non-slug database errors unchanged", async () => {
    mocks.txFn.mockImplementationOnce(async () => {
      throw new Error("connection refused");
    });

    await expect(
      organizationCreateHandler({ name: "Bad", slug: "bad-slug", planSlug: "free" }, CTX),
    ).rejects.toThrow("connection refused");
  });

  // ── happy path ───────────────────────────────────────────────────────────

  it("returns the new org's publicId, name, slug, and ISO createdAt", async () => {
    const result = await organizationCreateHandler(
      { name: "Acme Corp", slug: "acme", planSlug: "pro" },
      CTX,
    );

    expect(result.publicId).toBe("org_pub_1");
    expect(result.name).toBe("Acme Corp");
    expect(result.slug).toBe("acme");
    expect(result.createdAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("runs the insert inside a transaction", async () => {
    await organizationCreateHandler({ name: "Tx Test", slug: "tx-test", planSlug: "free" }, CTX);
    expect(mocks.txFn).toHaveBeenCalledTimes(1);
  });
});
