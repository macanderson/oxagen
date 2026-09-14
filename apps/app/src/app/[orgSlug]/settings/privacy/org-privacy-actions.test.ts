/**
 * org-privacy-actions.test.ts — authorization regression tests.
 *
 * Covers the two defects fixed in OXA security review:
 *   requestOrgDataEraseAction — the ownership check was a no-op
 *     (`rows.find(() => true)`); it must now go through assertSecurityManager
 *     (owner/admin) before invoking the destructive erase.
 *   getOrgExportStatusAction — queried by exportId only under withSystemDb
 *     (RLS bypassed); it must now assert org membership and scope by orgId.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockInvoke,
  mockGetSession,
  mockResolveOrg,
  mockAssertOrgMember,
  mockAssertSecurityManager,
  mockWithSystemDb,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockGetSession: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockAssertSecurityManager: vi.fn(),
  mockWithSystemDb: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mockInvoke }));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  assertOrgMember: mockAssertOrgMember,
  assertSecurityManager: mockAssertSecurityManager,
}));
vi.mock("@oxagen/database", () => ({
  withSystemDb: mockWithSystemDb,
  schema: {
    privacyExportRequests: {
      id: "id",
      orgId: "orgId",
      status: "status",
      exportUrl: "exportUrl",
    },
  },
}));

import {
  requestOrgDataEraseAction,
  getOrgExportStatusAction,
} from "./org-privacy-actions";

const ORG = { id: "org-1", slug: "acme" };
const SESSION = { user: { id: "user-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockAssertSecurityManager.mockResolvedValue(undefined);
  mockInvoke.mockResolvedValue({
    requestId: "r1",
    status: "queued",
    effectiveAt: "2026-07-01",
  });
  mockWithSystemDb.mockResolvedValue([
    { status: "ready", exportUrl: "https://blob/x" },
  ]);
});

describe("requestOrgDataEraseAction", () => {
  it("gates the destructive erase behind assertSecurityManager (owner/admin)", async () => {
    await requestOrgDataEraseAction("acme");
    expect(mockAssertSecurityManager).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockInvoke).toHaveBeenCalledWith(
      "erase_data",
      expect.objectContaining({ scope: "org", orgId: "org-1", confirm: true }),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does NOT erase when the security-manager gate rejects (non-owner caller)", async () => {
    mockAssertSecurityManager.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(requestOrgDataEraseAction("acme")).rejects.toThrow();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

describe("getOrgExportStatusAction", () => {
  it("asserts org membership before reading the export status", async () => {
    const res = await getOrgExportStatusAction("acme", "prexp_1");
    expect(mockResolveOrg).toHaveBeenCalledWith("acme");
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-1", "user-1");
    expect(res).toEqual({ status: "ready", exportUrl: "https://blob/x" });
  });

  it("does NOT read status when the membership assertion rejects (cross-org caller)", async () => {
    mockAssertOrgMember.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(getOrgExportStatusAction("acme", "prexp_1")).rejects.toThrow();
    expect(mockWithSystemDb).not.toHaveBeenCalled();
  });
});
