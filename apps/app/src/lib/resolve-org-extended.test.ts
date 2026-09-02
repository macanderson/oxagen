/**
 * resolve-org-extended.test.ts — covers assertOrgMember, assertMcpManager,
 * getOrgRole, and assertSecurityManager which are missing from resolve-org.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted stubs
// ---------------------------------------------------------------------------
const { notFoundMock, mockRows, mockWithSystemDb } = vi.hoisted(() => {
  const mockRows: unknown[] = [];
  const mockLimit = vi.fn(() => Promise.resolve(mockRows));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
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
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: mockWithSystemDb,
  };
});

vi.mock("server-only", () => ({}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, cache: (fn: unknown) => fn };
});

import {
  assertOrgMember,
  assertMcpManager,
  assertBillingManager,
  getOrgRole,
  assertSecurityManager,
} from "./resolve-org";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setRows(rows: unknown[]) {
  mockRows.length = 0;
  mockRows.push(...rows);
}

// ---------------------------------------------------------------------------
// assertOrgMember
// ---------------------------------------------------------------------------
describe("assertOrgMember", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves (void) when a member row exists", async () => {
    setRows([{ id: "row-1" }]);
    await expect(assertOrgMember("org-1", "user-1")).resolves.toBeUndefined();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("calls notFound() when no row is found (non-member)", async () => {
    setRows([]);
    await expect(assertOrgMember("org-1", "stranger")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// assertMcpManager
// ---------------------------------------------------------------------------
const MCP_ALLOWED_ROLES = ["owner", "admin"];
const MCP_DENIED_ROLES = ["member", "billing", "viewer", "guest"];

describe("assertMcpManager", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const role of MCP_ALLOWED_ROLES) {
    it(`role '${role}' → resolves without notFound`, async () => {
      setRows([{ role }]);
      await expect(
        assertMcpManager("org-1", "user-1"),
      ).resolves.toBeUndefined();
      expect(notFoundMock).not.toHaveBeenCalled();
    });
  }

  for (const role of MCP_DENIED_ROLES) {
    it(`role '${role}' → notFound()`, async () => {
      setRows([{ role }]);
      await expect(assertMcpManager("org-1", "user-1")).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
      expect(notFoundMock).toHaveBeenCalledOnce();
    });
  }

  it("no row (non-member) → notFound()", async () => {
    setRows([]);
    await expect(assertMcpManager("org-1", "nobody")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  it("null role → notFound()", async () => {
    setRows([{ role: null }]);
    await expect(assertMcpManager("org-1", "user-1")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getOrgRole
// ---------------------------------------------------------------------------
describe("getOrgRole", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the role string when a row exists", async () => {
    setRows([{ role: "admin" }]);
    expect(await getOrgRole("org-1", "user-1")).toBe("admin");
  });

  it("returns null when the user is not a member", async () => {
    setRows([]);
    expect(await getOrgRole("org-1", "user-x")).toBeNull();
  });

  it("returns the raw role value (owner)", async () => {
    setRows([{ role: "owner" }]);
    expect(await getOrgRole("org-1", "user-1")).toBe("owner");
  });
});

// ---------------------------------------------------------------------------
// assertSecurityManager
// ---------------------------------------------------------------------------
const SECURITY_ALLOWED = ["owner", "admin"];
const SECURITY_DENIED = ["member", "billing", "viewer", "guest"];

describe("assertSecurityManager", () => {
  beforeEach(() => vi.clearAllMocks());

  for (const role of SECURITY_ALLOWED) {
    it(`role '${role}' → resolves`, async () => {
      setRows([{ role }]);
      await expect(
        assertSecurityManager("org-1", "user-1"),
      ).resolves.toBeUndefined();
      expect(notFoundMock).not.toHaveBeenCalled();
    });
  }

  for (const role of SECURITY_DENIED) {
    it(`role '${role}' → notFound()`, async () => {
      setRows([{ role }]);
      await expect(assertSecurityManager("org-1", "user-1")).rejects.toThrow(
        "NEXT_NOT_FOUND",
      );
    });
  }

  it("non-member (no row) → notFound()", async () => {
    setRows([]);
    await expect(assertSecurityManager("org-1", "nobody")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });
});
