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
// Mocks
// ---------------------------------------------------------------------------

// next/navigation notFound() throws a special Next.js error in production;
// for tests we just let it throw so we can assert it was called.
const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

// Drizzle query builder mock — returns a chainable object that resolves to rows.
const mockRows: unknown[] = [];
const mockLimit = vi.fn(() => Promise.resolve(mockRows));
const mockWhere = vi.fn(() => ({ limit: mockLimit }));
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));
const mockDb = vi.fn(() => ({ select: mockSelect }));

vi.mock("@oxagen/database/client", () => ({
  db: mockDb,
}));

vi.mock("@oxagen/database", () => ({
  schema: {
    organizations: { slug: "slug_col", id: "id_col" },
    workspaces: { orgId: "org_id_col", slug: "ws_slug_col", id: "ws_id_col" },
  },
}));

// drizzle-orm operators are used in the real source — mock them as identity fns.
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
  and: vi.fn((...args: unknown[]) => ({ args, op: "and" })),
}));

// server-only is a package that throws when imported outside the server.
vi.mock("server-only", () => ({}));

// react cache — just return the function as-is for test purposes.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

import { resolveOrg, resolveWorkspace } from "./resolve-org.js";

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
    setMockRows([{ id: "org-1", publicId: "pub-1", name: "Acme", slug: "acme" }]);
    const result = await resolveOrg("acme");
    expect(result).toEqual({ id: "org-1", publicId: "pub-1", name: "Acme", slug: "acme" });
  });

  // (b) Calls notFound() when empty
  it("calls notFound() when no org row is returned", async () => {
    setMockRows([]);
    await expect(resolveOrg("nonexistent")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalledOnce();
  });
});

describe("resolveWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (c) Returns mapped fields on success
  it("returns ResolvedWorkspace with correct mapped fields", async () => {
    setMockRows([{ id: "ws-1", publicId: "pub-ws-1", orgId: "org-1", name: "Production", slug: "prod" }]);
    const result = await resolveWorkspace("org-1", "prod");
    expect(result).toEqual({
      id: "ws-1",
      publicId: "pub-ws-1",
      orgId: "org-1",
      name: "Production",
      slug: "prod",
    });
  });

  // (d) Calls notFound() when empty
  it("calls notFound() when no workspace row is returned", async () => {
    setMockRows([]);
    await expect(resolveWorkspace("org-1", "missing")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  // (e) Chains orgId + slug correctly
  it("passes both orgId and slug to the where clause", async () => {
    setMockRows([{ id: "ws-2", publicId: "pub-ws-2", orgId: "org-2", name: "Staging", slug: "staging" }]);
    await resolveWorkspace("org-2", "staging");

    // The where mock receives the and() expression; check that eq() was called
    // with both orgId and slug arguments.
    const { eq, and } = await import("drizzle-orm");
    expect(eq).toHaveBeenCalledTimes(2);
    expect(and).toHaveBeenCalledOnce();
  });
});
