/**
 * actions.test.ts — unit tests for revokeSessionAction.
 *
 * Covers:
 *   - validation: non-UUID targetUserId → validation_error
 *   - forbidden: assertSecurityManager throws → forbidden
 *   - not_found: member lookup returns 0 rows → not_found
 *   - not_found: session delete returns 0 rows → not_found
 *   - happy path: ok:true, emits security.session_revoked, revalidatePath called
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted fixtures
// ---------------------------------------------------------------------------

const {
  mockGetSession,
  mockResolveOrg,
  mockAssertSecurityManager,
  mockEmitSecurityEvent,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => {
  interface DbState {
    memberRows: { id: string }[];
    sessionDeleteReturning: { id: string }[];
  }
  const dbState: DbState = {
    memberRows: [{ id: "ou-1" }],
    sessionDeleteReturning: [{ id: "sess-1" }],
  };

  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockAssertSecurityManager: vi.fn(),
    mockEmitSecurityEvent: vi.fn(),
    mockRevalidatePath: vi.fn(),
    dbState,
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  assertSecurityManager: mockAssertSecurityManager,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mockEmitSecurityEvent,
}));

/** Error shaped like the sentinel `notFound()` throws (digest carries the 404 fallback code). */
function authDenial(): Error {
  const e = new Error("NEXT_HTTP_ERROR_FALLBACK");
  (e as Error & { digest: string }).digest = "NEXT_HTTP_ERROR_FALLBACK;404";
  return e;
}
vi.mock("@oxagen/database", () => {
  let callCount = 0;
  const makeTx = () => ({
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => {
            // First call = member lookup; subsequent calls = session delete won't use select
            callCount++;
            return Promise.resolve(dbState.memberRows);
          },
        }),
      }),
    }),
    delete: (_table: unknown) => ({
      where: (_w: unknown) => ({
        returning: (_cols: unknown) =>
          Promise.resolve(dbState.sessionDeleteReturning),
      }),
    }),
  });
  return {
    withSystemDb: vi.fn((fn: (tx: ReturnType<typeof makeTx>) => unknown) => {
      callCount = 0;
      return fn(makeTx());
    }),
    schema: {
      orgUsers: { orgId: "orgId_col", userId: "userId_col", id: "id_col" },
      sessions: { id: "id_col", userId: "userId_col" },
    },
  };
});

import { revokeSessionAction } from "./actions";

const SESSION = { user: { id: "actor-1" } };
const ORG = { id: "org-1", slug: "acme" };
const VALID_UUID = "b0000000-0000-0000-0000-000000000002";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setup() {
  vi.clearAllMocks();
  dbState.memberRows = [{ id: "ou-1" }];
  dbState.sessionDeleteReturning = [{ id: "sess-1" }];
  mockGetSession.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockAssertSecurityManager.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("revokeSessionAction", () => {
  beforeEach(setup);

  it("returns validation_error when orgSlug is empty", async () => {
    const res = await revokeSessionAction({
      orgSlug: "",
      sessionId: "sess-xyz",
      targetUserId: VALID_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("validation_error");
  });

  it("returns validation_error when sessionId is empty", async () => {
    const res = await revokeSessionAction({
      orgSlug: "acme",
      sessionId: "",
      targetUserId: VALID_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("validation_error");
  });

  it("returns validation_error when targetUserId is not a UUID", async () => {
    const res = await revokeSessionAction({
      orgSlug: "acme",
      sessionId: "sess-xyz",
      targetUserId: "not-a-uuid",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("validation_error");
  });

  it("returns forbidden when assertSecurityManager denies (notFound sentinel)", async () => {
    mockAssertSecurityManager.mockRejectedValue(authDenial());
    const res = await revokeSessionAction({
      orgSlug: "acme",
      sessionId: "sess-xyz",
      targetUserId: VALID_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("forbidden");
  });

  it("returns internal (NOT forbidden) when the auth gate hits a DB/infra error", async () => {
    // A plain Error has no notFound digest — it must NOT be misclassified as a
    // permission denial, or a degraded DB looks like an access denial to admins.
    mockAssertSecurityManager.mockRejectedValue(
      new Error("connection refused"),
    );
    const res = await revokeSessionAction({
      orgSlug: "acme",
      sessionId: "sess-xyz",
      targetUserId: VALID_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("internal");
  });

  it("returns not_found when target user is not an org member", async () => {
    dbState.memberRows = [];
    const res = await revokeSessionAction({
      orgSlug: "acme",
      sessionId: "sess-xyz",
      targetUserId: VALID_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("returns not_found when session delete returns 0 rows", async () => {
    dbState.sessionDeleteReturning = [];
    const res = await revokeSessionAction({
      orgSlug: "acme",
      sessionId: "sess-xyz",
      targetUserId: VALID_UUID,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("not_found");
  });

  it("returns ok:true and emits security.session_revoked on success", async () => {
    const res = await revokeSessionAction({
      orgSlug: "acme",
      sessionId: "sess-xyz",
      targetUserId: VALID_UUID,
    });
    expect(res.ok).toBe(true);
    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("security.session_revoked");
    expect(event.actorUserId).toBe("actor-1");
    expect(event.orgId).toBe("org-1");
    expect(event.requestId).toBe("sess-xyz");
    expect(event.outcome).toBe("success");
  });

  it("calls revalidatePath for the sessions page on success", async () => {
    await revokeSessionAction({
      orgSlug: "acme",
      sessionId: "sess-xyz",
      targetUserId: VALID_UUID,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/access/sessions");
  });
});
