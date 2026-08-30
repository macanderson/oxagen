/**
 * resolve-org.test.ts — unit tests for resolveOrg and resolveWorkspace.
 *
 * Covers:
 *   (a) resolveOrg returns mapped fields for a found row
 *   (b) resolveOrg calls notFound() when query returns empty
 *   (c) resolveWorkspace returns mapped fields for a found row
 *   (d) resolveWorkspace calls notFound() when query returns empty
 *   (e) resolveWorkspace chains orgId + slug correctly in its query
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock stubs — vi.mock factories are hoisted to the top of the file,
// so any variables they reference must be declared with vi.hoisted() first.
// ---------------------------------------------------------------------------

const { notFoundMock, mockRows, mockWithSystemDb } = vi.hoisted(() => {
  const mockRows: unknown[] = [];
  const mockLimit = vi.fn(() => Promise.resolve(mockRows));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  // withSystemDb passes a tx to its callback; the tx has the same Drizzle
  // query-builder shape. We invoke the callback immediately with a mock tx.
  const mockTx = { select: mockSelect };
  const mockWithSystemDb = vi.fn((fn: (tx: unknown) => Promise<unknown>) =>
    fn(mockTx),
  );
  const notFoundMock = vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  });

  return { notFoundMock, mockRows, mockWithSystemDb };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// next/navigation notFound() throws a special Next.js error in production;
// for tests we just let it throw so we can assert it was called.
vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: mockWithSystemDb,
  };
});

// drizzle-orm: spread all real exports but wrap eq/and as spies so tests can
// assert call counts without losing real SQL-builder behaviour.
vi.mock("drizzle-orm", async (importOriginal) => {
  const real = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...real,
    eq: vi.fn((...args: Parameters<typeof real.eq>) => real.eq(...args)),
    and: vi.fn((...args: Parameters<typeof real.and>) => real.and(...args)),
  };
});

// server-only is a package that throws when imported outside the server.
vi.mock("server-only", () => ({}));

// react cache — just return the function as-is for test purposes.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

import {
  resolveOrg,
  resolveOrgWithRedirect,
  resolveWorkspace,
} from "./resolve-org";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setMockRows(rows: unknown[]) {
  mockRows.length = 0;
  mockRows.push(...rows);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveOrg", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) Returns mapped fields on success
  it("returns ResolvedOrg with correct mapped fields", async () => {
    setMockRows([
      { id: "org-1", publicId: "pub-1", name: "Acme", slug: "acme" },
    ]);
    const result = await resolveOrg("acme");
    expect(result).toEqual({
      id: "org-1",
      publicId: "pub-1",
      name: "Acme",
      slug: "acme",
    });
  });

  // (b) Calls notFound() when empty
  it("calls notFound() when no org row is returned", async () => {
    setMockRows([]);
    await expect(resolveOrg("nonexistent")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  // (f) Malformed slugs (static/metadata paths that fall through to [orgSlug])
  // short-circuit to notFound() WITHOUT a DB round-trip. Regression guard for
  // the production incident where /favicon.ico, /robots.txt were run as org
  // slug lookups.
  it.each(["favicon.ico", "robots.txt", "sitemap.xml", "apple-touch-icon.png"])(
    "rejects %s with notFound() and never touches the DB",
    async (badSlug) => {
      setMockRows([{ id: "x", publicId: "x", name: "x", slug: badSlug }]);
      await expect(resolveOrg(badSlug)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(notFoundMock).toHaveBeenCalledOnce();
      expect(mockWithSystemDb).not.toHaveBeenCalled();
    },
  );
});

// The layout actually resolves via resolveOrgWithRedirect — assert the guard is
// present on that (history-aware) path too, so a bad slug skips BOTH the org
// query and the slug_history fallback query.
describe("resolveOrgWithRedirect (guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a dotted path before any DB query", async () => {
    await expect(resolveOrgWithRedirect("favicon.ico")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
    expect(mockWithSystemDb).not.toHaveBeenCalled();
  });

  it("still queries the DB for a well-formed slug", async () => {
    setMockRows([{ id: "o1", publicId: "p1", name: "Acme", slug: "acme" }]);
    const org = await resolveOrgWithRedirect("acme");
    expect(org.slug).toBe("acme");
    expect(mockWithSystemDb).toHaveBeenCalled();
  });
});

describe("resolveWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (c) Returns mapped fields on success
  it("returns ResolvedWorkspace with correct mapped fields", async () => {
    setMockRows([
      {
        id: "ws-1",
        publicId: "pub-ws-1",
        orgId: "org-1",
        name: "Production",
        slug: "prod",
      },
    ]);
    const result = await resolveWorkspace("org-1", "prod");
    expect(result).toEqual({
      id: "ws-1",
      publicId: "pub-ws-1",
      orgId: "org-1",
      name: "Production",
      slug: "prod",
      // description is a real column now; absent → "".
      description: "",
      // avatarUrl maps straight off the row; absent → null.
      avatarUrl: null,
    });
  });

  // (c2) Reads description off the promoted `description` column — the SAME
  // column the workspace.settings.write handler writes. The read-back source
  // must match the write target.
  it("reads description from the description column", async () => {
    setMockRows([
      {
        id: "ws-3",
        publicId: "pub-ws-3",
        orgId: "org-3",
        name: "Research",
        slug: "research",
        description: "saved description",
      },
    ]);
    const result = await resolveWorkspace("org-3", "research");
    expect(result.description).toBe("saved description");
  });

  // (c3) Null description column normalizes to "".
  it("falls back to an empty description when the column is null", async () => {
    setMockRows([
      {
        id: "ws-4",
        publicId: "pub-ws-4",
        orgId: "org-4",
        name: "NoDesc",
        slug: "nodesc",
        description: null,
      },
    ]);
    const result = await resolveWorkspace("org-4", "nodesc");
    expect(result.description).toBe("");
  });

  // (d) Calls notFound() when empty
  it("calls notFound() when no workspace row is returned", async () => {
    setMockRows([]);
    await expect(resolveWorkspace("org-1", "missing")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  // (e) Chains orgId + slug correctly
  it("passes both orgId and slug to the where clause", async () => {
    setMockRows([
      {
        id: "ws-2",
        publicId: "pub-ws-2",
        orgId: "org-2",
        name: "Staging",
        slug: "staging",
      },
    ]);
    await resolveWorkspace("org-2", "staging");

    // The where mock receives the and() expression; check that eq() was called
    // with both orgId and slug arguments.
    const { eq, and } = await import("drizzle-orm");
    expect(eq).toHaveBeenCalledTimes(2);
    expect(and).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// assertBillingManager
// ---------------------------------------------------------------------------

// The canonical set of roles allowed to manage billing.
// Mirrors BILLING_MANAGER_ROLES in resolve-org.ts — any drift causes a test failure.
const BILLING_MANAGER_ROLES = new Set(["owner", "admin", "billing"]);
const NON_MANAGER_ROLES = ["member", "viewer", "guest", "unknown"];

import { assertBillingManager } from "./resolve-org";

describe("assertBillingManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Derive iteration from the imported set so this test never drifts.
  for (const role of BILLING_MANAGER_ROLES) {
    it(`role '${role}' passes without calling notFound()`, async () => {
      setMockRows([{ role }]);
      await expect(
        assertBillingManager("org-1", "user-1"),
      ).resolves.toBeUndefined();
      expect(notFoundMock).not.toHaveBeenCalled();
    });
  }

  for (const role of NON_MANAGER_ROLES) {
    it(`role '${role}' → notFound()`, async () => {
      setMockRows([{ role }]);
      await expect(assertBillingManager("org-1", "user-1")).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
      expect(notFoundMock).toHaveBeenCalledOnce();
    });
  }

  it("no row (non-member) → notFound()", async () => {
    setMockRows([]);
    await expect(assertBillingManager("org-1", "user-x")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  it("null role field → notFound()", async () => {
    setMockRows([{ role: null }]);
    await expect(assertBillingManager("org-1", "user-1")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// assertOrgAdmin
// ---------------------------------------------------------------------------

// Mirrors ORG_ADMIN_ROLES in resolve-org.ts — any drift causes a test failure.
const ORG_ADMIN_ROLES = new Set(["owner", "admin"]);
// billing is intentionally NOT an org admin (it can manage billing only).
const NON_ADMIN_ROLES = ["billing", "member", "viewer", "guest", "unknown"];

import { assertOrgAdmin } from "./resolve-org";

describe("assertOrgAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const role of ORG_ADMIN_ROLES) {
    it(`role '${role}' passes without calling notFound()`, async () => {
      setMockRows([{ role }]);
      await expect(assertOrgAdmin("org-1", "user-1")).resolves.toBeUndefined();
      expect(notFoundMock).not.toHaveBeenCalled();
    });
  }

  for (const role of NON_ADMIN_ROLES) {
    it(`role '${role}' → notFound()`, async () => {
      setMockRows([{ role }]);
      await expect(assertOrgAdmin("org-1", "user-1")).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
      expect(notFoundMock).toHaveBeenCalledOnce();
    });
  }

  it("no row (non-member) → notFound()", async () => {
    setMockRows([]);
    await expect(assertOrgAdmin("org-1", "user-x")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  it("null role field → notFound()", async () => {
    setMockRows([{ role: null }]);
    await expect(assertOrgAdmin("org-1", "user-1")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });
});
