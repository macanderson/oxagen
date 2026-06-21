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

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(SESSION);
  mockWithSystemDb.mockResolvedValue([
    { status: "ready", exportUrl: "https://blob/x", completedAt: null },
  ]);
});

describe("getExportStatusAction", () => {
  it("requires a session before reading export status", async () => {
    const res = await getExportStatusAction("prexp_1");
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ status: "ready", exportUrl: "https://blob/x" });
  });

  it("does NOT read status when there is no session (redirect)", async () => {
    mockGetSession.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(getExportStatusAction("prexp_1")).rejects.toThrow();
    expect(mockWithSystemDb).not.toHaveBeenCalled();
  });
});
