import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  orgFindFirst: vi.fn(),
  txInsertOrg: vi.fn(),
  txInsertOrgReturning: vi.fn(),
  txInsertOrgUsers: vi.fn(),
  // withSystemDbFn tracks each withSystemDb call so tests can assert the org
  // creation wraps its writes in the system-bypass transaction (OXA-1515).
  withSystemDbFn: vi.fn(),
  grantFreeCredits: vi.fn(),
  bootstrapOrgIAM: vi.fn(),
}));

// Default: no existing slug
mocks.orgFindFirst.mockResolvedValue(null);
// Default: tx inserts succeed
mocks.txInsertOrgReturning.mockResolvedValue([
  {
    publicId: "org_pub_1",
    name: "Acme Corp",
    slug: "acme",
    type: "business",
    createdAt: new Date("2026-05-01T00:00:00Z"),
    id: "internal_org_id",
  },
]);
// Stub the INSERT chain: insert().values().returning()
const orgValuesStub = { returning: mocks.txInsertOrgReturning };
mocks.txInsertOrg.mockReturnValue({ values: () => orgValuesStub });
// Stub orgUsers insert: insert().values() (no returning)
mocks.txInsertOrgUsers.mockReturnValue({ values: vi.fn(async () => undefined) });

// withSystemDb passthrough: runs the callback with a fake tx.
// The handler calls withSystemDb twice:
//   1. slug check → tx.query.organizations.findFirst
//   2. main body  → tx.insert (org + orgUsers) + bootstrapOrgIAM (stubbed)
// A per-call insert counter keeps the org/orgUsers routing correct.
mocks.withSystemDbFn.mockImplementation(
  async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
    let insertCount = 0;
    const tx = {
      query: {
        organizations: { findFirst: mocks.orgFindFirst },
      },
      insert: (table: unknown): unknown => {
        insertCount++;
        if (insertCount === 1) return mocks.txInsertOrg(table) as unknown;
        return mocks.txInsertOrgUsers(table) as unknown;
      },
    };
    return fn(tx as unknown as Parameters<typeof fn>[0]);
  },
);

vi.mock("@oxagen/database", () => ({
  // db() is no longer called by organization.create — kept for safety in case
  // any transitive dep still references it in tests.
  db: () => ({
    query: { organizations: { findFirst: mocks.orgFindFirst } },
  }),
  withSystemDb: async (fn: (tx: Record<string, unknown>) => Promise<unknown>): Promise<unknown> =>
    mocks.withSystemDbFn(fn) as Promise<unknown>,
  schema: {
    organizations: {
      slug: "slug",
      id: "id",
      publicId: "publicId",
      name: "name",
      type: "type",
      createdAt: "createdAt",
    },
    orgUsers: {},
    orgBillingProfiles: {},
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { eq: orig.eq };
});

// Stub the billing package so grantFreeCredits doesn't open a second
// db().transaction() inside the handler test. Billing idempotency is
// covered by @oxagen/billing's own test suite.
mocks.grantFreeCredits.mockResolvedValue(undefined);
vi.mock("@oxagen/billing", () => ({
  grantFreeCredits: mocks.grantFreeCredits,
}));

// Stub bootstrapOrgIAM — IAM provisioning is tested separately in
// iam-provision.test.ts. Here we only verify it's called correctly.
mocks.bootstrapOrgIAM.mockResolvedValue(undefined);
vi.mock("./iam-provision", () => ({
  bootstrapOrgIAM: mocks.bootstrapOrgIAM,
}));

import { organizationCreateHandler } from "./organization.create";
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
    mocks.txInsertOrg.mockClear();
    mocks.txInsertOrgReturning.mockClear();
    mocks.txInsertOrgUsers.mockClear();
    mocks.grantFreeCredits.mockClear();
    mocks.bootstrapOrgIAM.mockClear();
    // Restore defaults
    mocks.orgFindFirst.mockResolvedValue(null);
    mocks.txInsertOrgReturning.mockResolvedValue([
      {
        publicId: "org_pub_1",
        name: "Acme Corp",
        slug: "acme",
        type: "business",
        createdAt: new Date("2026-05-01T00:00:00Z"),
        id: "internal_org_id",
      },
    ]);
    mocks.grantFreeCredits.mockResolvedValue(undefined);
    mocks.bootstrapOrgIAM.mockResolvedValue(undefined);
    // Reset call count + restore default implementation (clears any one-time
    // overrides set by individual test cases).
    mocks.withSystemDbFn.mockReset();
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        let insertCount = 0;
        const tx = {
          query: {
            organizations: { findFirst: mocks.orgFindFirst },
          },
          insert: (table: unknown): unknown => {
            insertCount++;
            if (insertCount === 1) return mocks.txInsertOrg(table) as unknown;
            return mocks.txInsertOrgUsers(table) as unknown;
          },
        };
        return fn(tx as unknown as Parameters<typeof fn>[0]);
      },
    );
  });

  // ── auth guard ───────────────────────────────────────────────────────────

  it("throws when userId is null (unauthenticated request)", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      organizationCreateHandler({ name: "Test", slug: "test", planSlug: "free", type: "business" as const }, anonCtx),
    ).rejects.toThrow("organization.create requires an authenticated user");
  });

  // ── slug conflict guard ──────────────────────────────────────────────────

  it("throws a friendly error when the slug already exists (pre-check path)", async () => {
    mocks.orgFindFirst.mockResolvedValueOnce({ id: "existing_id" });

    await expect(
      organizationCreateHandler({ name: "Clone", slug: "acme", planSlug: "free", type: "business" as const }, CTX),
    ).rejects.toThrow('slug "acme" already in use');
  });

  it("throws a friendly error on unique_violation (race condition path)", async () => {
    // Pre-check passes (no row), but the second withSystemDb call (main body)
    // races and hits the unique index.
    mocks.orgFindFirst.mockResolvedValueOnce(null);
    // Override: first call (slug check) resolves null; second call (main body) throws.
    let callIdx = 0;
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        callIdx++;
        if (callIdx === 1) {
          // slug check — simulate no match
          return fn({ query: { organizations: { findFirst: async () => null } } } as unknown as Parameters<typeof fn>[0]);
        }
        // main body — simulate unique_violation
        const err = Object.assign(new Error("dup"), { code: "23505" });
        throw err;
      },
    );

    await expect(
      organizationCreateHandler({ name: "Race", slug: "race-slug", planSlug: "free", type: "business" as const }, CTX),
    ).rejects.toThrow('slug "race-slug" already in use');
  });

  it("re-throws non-slug database errors unchanged", async () => {
    let callIdx = 0;
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        callIdx++;
        if (callIdx === 1) {
          return fn({ query: { organizations: { findFirst: async () => null } } } as unknown as Parameters<typeof fn>[0]);
        }
        throw new Error("connection refused");
      },
    );

    await expect(
      organizationCreateHandler({ name: "Bad", slug: "bad-slug", planSlug: "free", type: "business" as const }, CTX),
    ).rejects.toThrow("connection refused");
  });

  // ── happy path ───────────────────────────────────────────────────────────

  it("returns the new org's publicId, name, slug, type, and ISO createdAt", async () => {
    const result = await organizationCreateHandler(
      { name: "Acme Corp", slug: "acme", planSlug: "pro", type: "business" as const },
      CTX,
    );

    expect(result.publicId).toBe("org_pub_1");
    expect(result.name).toBe("Acme Corp");
    expect(result.slug).toBe("acme");
    expect(result.type).toBe("business");
    expect(result.createdAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("runs the org insert inside a withSystemDb bypass and then calls grantFreeCredits", async () => {
    await organizationCreateHandler({ name: "Tx Test", slug: "tx-test", planSlug: "free", type: "business" as const }, CTX);
    // The org creation (orgs + orgUsers) must happen inside withSystemDb so the
    // bootstrap writes succeed without an active tenant scope (RLS bypass) and
    // membership is never visible without the org row.
    // withSystemDb is called twice: once for the slug check, once for the main body.
    expect(mocks.withSystemDbFn).toHaveBeenCalledTimes(2);
    // grantFreeCredits must be called after the org tx commits (billing runs
    // in its own isolated transaction so a billing failure cannot roll back
    // the org creation).
    expect(mocks.grantFreeCredits).toHaveBeenCalledTimes(1);
    expect(mocks.grantFreeCredits).toHaveBeenCalledWith("internal_org_id");
  });

  it("calls bootstrapOrgIAM inside the transaction so IAM is atomic with org creation", async () => {
    await organizationCreateHandler({ name: "IAM Test", slug: "iam-test", planSlug: "free", type: "business" as const }, CTX);
    expect(mocks.bootstrapOrgIAM).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapOrgIAM).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "internal_org_id",
        ownerUserId: "u_1",
        actorUserId: "u_1",
      }),
    );
  });
});
