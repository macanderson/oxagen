/**
 * actions.test.ts — unit tests for revokeOwnSessionAction.
 *
 * Covers:
 *   - Happy path: session belonging to the user is deleted
 *   - Self-session guard: cannot revoke the current session
 *   - Not-found path: session doesn't exist or doesn't belong to user
 *   - Validation error: bad input
 *
 * Mock seam: @oxagen/database (withSystemDb), @/lib/session, next/cache,
 *            @oxagen/database/security (emitSecurityEvent).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before imports (vi.mock is hoisted).
// ---------------------------------------------------------------------------

const {
  mockWithSystemDb,
  mockEmitSecurityEvent,
  mockRevalidatePath,
  mockGetSessionOrRedirect,
} = vi.hoisted(() => ({
  mockWithSystemDb: vi.fn(),
  mockEmitSecurityEvent: vi.fn(),
  mockRevalidatePath: vi.fn(),
  mockGetSessionOrRedirect: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: mockWithSystemDb,
  };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mockEmitSecurityEvent,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mockGetSessionOrRedirect,
}));

import { revokeOwnSessionAction } from "./actions";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CURRENT_SESSION_ID = "session-current-123";
const OTHER_SESSION_ID = "session-other-456";

const mockSession = {
  user: { id: "user-abc", email: "user@example.com" },
  session: { id: CURRENT_SESSION_ID },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("revokeOwnSessionAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionOrRedirect.mockResolvedValue(mockSession);
  });

  it("happy path: successfully deletes another session and emits audit event", async () => {
    mockWithSystemDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      // Simulate a successful delete returning one row.
      const tx = {
        delete: () => ({
          where: () => ({
            returning: () => Promise.resolve([{ id: OTHER_SESSION_ID }]),
          }),
        }),
      };
      return fn(tx);
    });

    const result = await revokeOwnSessionAction({
      sessionId: OTHER_SESSION_ID,
    });

    expect(result.ok).toBe(true);
    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    expect(mockEmitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "security.session_revoked",
        actorUserId: "user-abc",
        outcome: "success",
        requestId: OTHER_SESSION_ID,
      }),
    );
    expect(mockRevalidatePath).toHaveBeenCalledWith("/account/security");
  });

  it("self-session guard: returns self_session when revoking the current session", async () => {
    const result = await revokeOwnSessionAction({
      sessionId: CURRENT_SESSION_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("self_session");
    }
    // No DB call, no event emission.
    expect(mockWithSystemDb).not.toHaveBeenCalled();
    expect(mockEmitSecurityEvent).not.toHaveBeenCalled();
  });

  it("not_found: returns not_found when the session does not belong to the user", async () => {
    mockWithSystemDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      // Simulate delete returning no rows (session not found or not owned by user).
      const tx = {
        delete: () => ({
          where: () => ({
            returning: () => Promise.resolve([]),
          }),
        }),
      };
      return fn(tx);
    });

    const result = await revokeOwnSessionAction({
      sessionId: OTHER_SESSION_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
    }
    expect(mockEmitSecurityEvent).not.toHaveBeenCalled();
  });

  it("validation_error: returns validation_error for empty sessionId", async () => {
    const result = await revokeOwnSessionAction({ sessionId: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_error");
    }
    expect(mockWithSystemDb).not.toHaveBeenCalled();
  });

  it("internal: returns internal error when the DB throws", async () => {
    mockWithSystemDb.mockImplementation(() => {
      throw new Error("connection timeout");
    });

    const result = await revokeOwnSessionAction({
      sessionId: OTHER_SESSION_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("internal");
    }
    expect(mockEmitSecurityEvent).not.toHaveBeenCalled();
  });

  it("works when session.session is undefined (no current session id to guard against)", async () => {
    // Some auth flows may not include the session object.
    mockGetSessionOrRedirect.mockResolvedValue({
      user: { id: "user-abc", email: "user@example.com" },
      session: undefined,
    });

    mockWithSystemDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      const tx = {
        delete: () => ({
          where: () => ({
            returning: () => Promise.resolve([{ id: OTHER_SESSION_ID }]),
          }),
        }),
      };
      return fn(tx);
    });

    const result = await revokeOwnSessionAction({
      sessionId: OTHER_SESSION_ID,
    });
    // Should succeed — no current session id to compare against.
    expect(result.ok).toBe(true);
  });
});
