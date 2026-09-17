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

const { mockGetSession, capturedWhere, dbState } = vi.hoisted(() => {
  return {
    mockGetSession: vi.fn(),
    capturedWhere: { value: undefined as unknown },
    dbState: {
      rows: [] as Array<{
        status: string;
        exportUrl: string | null;
        completedAt: Date | null;
      }>,
    },
  };
});

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: vi.fn() }));

// Capture the where() predicate so we can assert userId scoping is applied.
vi.mock("@oxagen/database", () => {
  const makeTx = () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (w: unknown) => {
          capturedWhere.value = w;
          return { limit: (_n: number) => Promise.resolve(dbState.rows) };
        },
      }),
    }),
  });
  return {
    withSystemDb: vi.fn((fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
      fn(makeTx()),
    ),
    schema: {
      privacyExportRequests: {
        id: "id_col",
        status: "status_col",
        exportUrl: "exportUrl_col",
        completedAt: "completedAt_col",
        userId: "userId_col",
      },
    },
  };
});

// `and` / `eq` return marker objects so we can assert the predicate was built.
vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ __and: parts }),
  eq: (col: unknown, val: unknown) => ({ __eq: [col, val] }),
}));

import { getExportStatusAction } from "./privacy-actions";

const SESSION = { user: { id: "user-1" } };

describe("getExportStatusAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedWhere.value = undefined;
    dbState.rows = [
      {
        status: "ready",
        exportUrl: "https://blob/export",
        completedAt: new Date(),
      },
    ];
    mockGetSession.mockResolvedValue(SESSION);
  });

  it("requires a session (self-authenticates)", async () => {
    mockGetSession.mockRejectedValue(new Error("unauthenticated"));
    await expect(getExportStatusAction("prexp-1")).rejects.toThrow(
      "unauthenticated",
    );
  });

  it("scopes the lookup to the caller's own userId (cross-user IDOR guard)", async () => {
    await getExportStatusAction("prexp-1");
    // The where predicate must include an eq(userId, session.user.id) clause.
    const where = capturedWhere.value as {
      __and: Array<{ __eq: [unknown, unknown] }>;
    };
    expect(where.__and).toBeDefined();
    const scopedToUser = where.__and.some(
      (c) => c.__eq?.[0] === "userId_col" && c.__eq?.[1] === "user-1",
    );
    expect(scopedToUser).toBe(true);
  });

  it("returns the row when it belongs to the caller", async () => {
    const res = await getExportStatusAction("prexp-1");
    expect(res).toMatchObject({
      status: "ready",
      exportUrl: "https://blob/export",
    });
  });

  it("returns null when no owned row matches (foreign or missing export)", async () => {
    dbState.rows = [];
    const res = await getExportStatusAction("prexp-foreign");
    expect(res).toBeNull();
  });
});
