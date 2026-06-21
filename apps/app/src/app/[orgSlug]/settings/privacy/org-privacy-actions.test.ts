/**
 * org-privacy-actions.test.ts — unit tests for getOrgExportStatusAction.
 *
 * Regression for the cross-org IDOR silent-failure fix: the status poll must
 * self-authenticate and assert the caller is a member of the org that owns the
 * export before returning its signed URL. A non-member must be denied (the
 * assertOrgMember 404 sentinel surfaces) rather than receiving any other org's
 * export URL by guessing a UUID.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetSession, mockAssertOrgMember, dbState } = vi.hoisted(() => {
  return {
    mockGetSession: vi.fn(),
    mockAssertOrgMember: vi.fn(),
    dbState: {
      rows: [] as Array<{ status: string; exportUrl: string | null; orgId: string }>,
    },
  };
});

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(),
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: vi.fn() }));
vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
}));
vi.mock("@oxagen/database", () => {
  const makeTx = () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => Promise.resolve(dbState.rows),
        }),
      }),
    }),
  });
  return {
    withSystemDb: vi.fn((fn: (tx: ReturnType<typeof makeTx>) => unknown) => fn(makeTx())),
    schema: {
      privacyExportRequests: {
        id: "id_col",
        status: "status_col",
        exportUrl: "exportUrl_col",
        orgId: "orgId_col",
      },
      orgUsers: { orgId: "ou_orgId", role: "ou_role" },
    },
  };
});

import { getOrgExportStatusAction } from "./org-privacy-actions";

const SESSION = { user: { id: "user-1" } };

describe("getOrgExportStatusAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rows = [{ status: "ready", exportUrl: "https://blob/org-export", orgId: "org-9" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  it("requires a session (self-authenticates)", async () => {
    mockGetSession.mockRejectedValue(new Error("unauthenticated"));
    await expect(getOrgExportStatusAction("prexp-1")).rejects.toThrow("unauthenticated");
  });

  it("asserts org membership against the export's owning org", async () => {
    await getOrgExportStatusAction("prexp-1");
    expect(mockAssertOrgMember).toHaveBeenCalledWith("org-9", "user-1");
  });

  it("propagates the denial (404 sentinel) for a non-member — no cross-org leak", async () => {
    mockAssertOrgMember.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(getOrgExportStatusAction("prexp-1")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("returns null without asserting membership when the export does not exist", async () => {
    dbState.rows = [];
    const res = await getOrgExportStatusAction("prexp-missing");
    expect(res).toBeNull();
    expect(mockAssertOrgMember).not.toHaveBeenCalled();
  });

  it("returns status + url for a member of the owning org", async () => {
    const res = await getOrgExportStatusAction("prexp-1");
    expect(res).toEqual({ status: "ready", exportUrl: "https://blob/org-export" });
  });
});
