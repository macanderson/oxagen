/**
 * privacy-actions.test.ts — authorization regression test for the account-level
 * export-status read.
 *
 * Defect fixed: getExportStatusAction queried privacyExportRequests by id only
 * under withSystemDb (RLS bypassed) with no session and no userId filter, so any
 * authed user could poll any export id and retrieve another user's signed
 * exportUrl (IDOR). It must now require a session and scope by userId.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInvoke, mockGetSession, mockWithSystemDb } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockGetSession: vi.fn(),
  mockWithSystemDb: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mockInvoke }));
vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@oxagen/database", () => ({
  withSystemDb: mockWithSystemDb,
  schema: {
    organizations: { id: "id" },
    orgUsers: { userId: "userId", orgId: "orgId" },
    privacyExportRequests: {
      id: "id",
      userId: "userId",
      status: "status",
      exportUrl: "exportUrl",
      completedAt: "completedAt",
    },
  },
}));

import { getExportStatusAction } from "./privacy-actions";

const SESSION = { user: { id: "user-1" } };

describe("getExportStatusAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.value = undefined;
    dbState.rows = [{ status: "ready", exportUrl: "https://blob/export", completedAt: new Date() }];
    mockGetSession.mockResolvedValue(SESSION);
  });

  it("requires a session (self-authenticates)", async () => {
    mockGetSession.mockRejectedValue(new Error("unauthenticated"));
    await expect(getExportStatusAction("prexp-1")).rejects.toThrow("unauthenticated");
  });

  it("scopes the lookup to the caller's own userId (cross-user IDOR guard)", async () => {
    await getExportStatusAction("prexp-1");
    // The where predicate must include an eq(userId, session.user.id) clause.
    const where = capturedWhere.value as { __and: Array<{ __eq: [unknown, unknown] }> };
    expect(where.__and).toBeDefined();
    const scopedToUser = where.__and.some(
      (c) => c.__eq?.[0] === "userId_col" && c.__eq?.[1] === "user-1",
    );
    expect(scopedToUser).toBe(true);
  });

  it("returns the row when it belongs to the caller", async () => {
    const res = await getExportStatusAction("prexp-1");
    expect(res).toMatchObject({ status: "ready", exportUrl: "https://blob/export" });
  });

  it("returns null when no owned row matches (foreign or missing export)", async () => {
    dbState.rows = [];
    const res = await getExportStatusAction("prexp-foreign");
    expect(res).toBeNull();
  });
});
