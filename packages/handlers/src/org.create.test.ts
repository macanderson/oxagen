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
mocks.txInsertOrgUsers.mockReturnValue({
  values: vi.fn(async () => undefined),
});

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
      // Namespace derivation reads existing org namespaces before the insert;
      // an empty set means the slug-derived namespace is used verbatim.
      select: () => ({ from: async () => [] }),
      insert: (table: unknown): unknown => {
        insertCount++;
        if (insertCount === 1) return mocks.txInsertOrg(table) as unknown;
        return mocks.txInsertOrgUsers(table) as unknown;
      },
    };
    return fn(tx as unknown as Parameters<typeof fn>[0]);
  },
);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    // db() is no longer called by organization.create — kept for safety in case
    // any transitive dep still references it in tests.
    db: () => ({
      query: { organizations: { findFirst: mocks.orgFindFirst } },
    }),
    withSystemDb: async (
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
    ): Promise<unknown> => mocks.withSystemDbFn(fn) as Promise<unknown>,
  };
});

// Stub the billing package so grantFreeCredits doesn't open a second
// db().transaction() inside the handler test. Billing idempotency is
// covered by @oxagen/billing's own test suite.
mocks.grantFreeCredits.mockResolvedValue(undefined);
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    grantFreeCredits: mocks.grantFreeCredits,
  };
});

// Stub bootstrapOrgIAM — IAM provisioning is tested separately in
// iam-provision.test.ts. Here we only verify it's called correctly.
mocks.bootstrapOrgIAM.mockResolvedValue(undefined);
vi.mock("./iam-provision", () => ({
  bootstrapOrgIAM: mocks.bootstrapOrgIAM,
}));

import { organizationCreateHandler } from "./org.create";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

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
          // See note above: namespace derivation reads existing namespaces first.
          select: () => ({ from: async () => [] }),
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
      organizationCreateHandler(
        {
          name: "Test",
          slug: "test",
          planSlug: "free",
          type: "business" as const,
        },
        anonCtx,
      ),
    ).rejects.toThrow("organization.create requires an authenticated user");
  });

  // ── slug conflict guard ──────────────────────────────────────────────────

  it("throws a friendly error when the slug already exists (pre-check path)", async () => {
    mocks.orgFindFirst.mockResolvedValueOnce({ id: "existing_id" });

    await expect(
      organizationCreateHandler(
        {
          name: "Clone",
          slug: "acme",
          planSlug: "free",
          type: "business" as const,
        },
        CTX,
      ),
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
          return fn({
            query: { organizations: { findFirst: async () => null } },
          } as unknown as Parameters<typeof fn>[0]);
        }
        // main body — simulate unique_violation
        const err = Object.assign(new Error("dup"), { code: "23505" });
        throw err;
      },
    );

    await expect(
      organizationCreateHandler(
        {
          name: "Race",
          slug: "race-slug",
          planSlug: "free",
          type: "business" as const,
        },
        CTX,
      ),
    ).rejects.toThrow('slug "race-slug" already in use');
  });

  it("re-throws non-slug database errors unchanged", async () => {
    let callIdx = 0;
    mocks.withSystemDbFn.mockImplementation(
      async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
        callIdx++;
        if (callIdx === 1) {
          return fn({
            query: { organizations: { findFirst: async () => null } },
          } as unknown as Parameters<typeof fn>[0]);
        }
        throw new Error("connection refused");
      },
    );

    await expect(
      organizationCreateHandler(
        {
          name: "Bad",
          slug: "bad-slug",
          planSlug: "free",
          type: "business" as const,
        },
        CTX,
      ),
    ).rejects.toThrow("connection refused");
  });

  // ── happy path ───────────────────────────────────────────────────────────

  it("returns the new org's publicId, name, slug, type, and ISO createdAt", async () => {
    const result = await organizationCreateHandler(
      {
        name: "Acme Corp",
        slug: "acme",
        planSlug: "free",
        type: "business" as const,
      },
      CTX,
    );

    expect(result.publicId).toBe("org_pub_1");
    expect(result.name).toBe("Acme Corp");
    expect(result.slug).toBe("acme");
    expect(result.type).toBe("business");
    expect(result.createdAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("runs the org insert inside a withSystemDb bypass and then calls grantFreeCredits", async () => {
    await organizationCreateHandler(
      {
        name: "Tx Test",
        slug: "tx-test",
        planSlug: "free",
        type: "business" as const,
      },
      CTX,
    );
    // The org creation (orgs + orgUsers) must happen inside withSystemDb so the
    // bootstrap writes succeed without an active tenant scope (RLS bypass) and
    // membership is never visible without the org row.
    // withSystemDb is called twice: (1) the slug pre-check, (2) the main
    // body (org + orgUsers + IAM). The old MCP registry sync call (previously
    // the 3rd call) was removed in the workspace-scoping rebuild (2026-06-17)
    // — registries are now per-(org, workspace), seeded at workspace creation.
    expect(mocks.withSystemDbFn).toHaveBeenCalledTimes(2);
    // grantFreeCredits must be called after the org tx commits (billing runs
    // in its own isolated transaction so a billing failure cannot roll back
    // the org creation).
    expect(mocks.grantFreeCredits).toHaveBeenCalledTimes(1);
    expect(mocks.grantFreeCredits).toHaveBeenCalledWith("internal_org_id");
  });

  it("calls bootstrapOrgIAM inside the transaction so IAM is atomic with org creation", async () => {
    await organizationCreateHandler(
      {
        name: "IAM Test",
        slug: "iam-test",
        planSlug: "free",
        type: "business" as const,
      },
      CTX,
    );
    expect(mocks.bootstrapOrgIAM).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapOrgIAM).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "internal_org_id",
        ownerUserId: "u_1",
        actorUserId: "u_1",
      }),
    );
  });

  // ── grantFreeCredits error handling with idempotent retry ───────────────

  it("retries grantFreeCredits once on first failure — org creation still succeeds", async () => {
    // First call fails, retry succeeds.
    mocks.grantFreeCredits
      .mockRejectedValueOnce(new Error("billing service unavailable"))
      .mockResolvedValueOnce(undefined);

    const result = await organizationCreateHandler(
      {
        name: "Credits Retry",
        slug: "credits-retry",
        planSlug: "free",
        type: "business" as const,
      },
      CTX,
    );

    // Org was created successfully.
    expect(result.publicId).toBe("org_pub_1");
    // grantFreeCredits must have been called twice: first attempt + one retry.
    expect(mocks.grantFreeCredits).toHaveBeenCalledTimes(2);
    expect(mocks.grantFreeCredits).toHaveBeenCalledWith("internal_org_id");
  });

  it("does not throw when both grantFreeCredits attempts fail — org creation still succeeds", async () => {
    // Both attempts fail (transient infra failure). Org creation must not surface
    // the billing error since the org row is committed and the grant can be
    // re-applied manually using the orgId logged at error level.
    mocks.grantFreeCredits
      .mockRejectedValueOnce(new Error("billing DB down"))
      .mockRejectedValueOnce(new Error("billing DB down"));

    const result = await organizationCreateHandler(
      {
        name: "Credits Both Fail",
        slug: "credits-both-fail",
        planSlug: "free",
        type: "business" as const,
      },
      CTX,
    );

    // Org was created successfully despite both grantFreeCredits failures.
    expect(result.publicId).toBe("org_pub_1");
    expect(result.slug).toBe("acme");
    // Both attempts must be made.
    expect(mocks.grantFreeCredits).toHaveBeenCalledTimes(2);
  });

  it("succeeds without retrying when first grantFreeCredits call succeeds", async () => {
    // Happy path: grantFreeCredits succeeds on first try — no retry needed.
    mocks.grantFreeCredits.mockResolvedValueOnce(undefined);

    await organizationCreateHandler(
      {
        name: "Credits OK",
        slug: "credits-ok",
        planSlug: "free",
        type: "business" as const,
      },
      CTX,
    );

    // Must only be called once when the first attempt succeeds.
    expect(mocks.grantFreeCredits).toHaveBeenCalledTimes(1);
  });
});
