/**
 * actions.test.ts — unit tests for saveMfaPolicyAction and loadMfaPolicy.
 *
 * Covers:
 *   saveMfaPolicyAction:
 *     - validation: mfaGraceHours > 720 → validation_error
 *     - validation: mfaGraceHours < 0 → validation_error
 *     - forbidden: assertSecurityManager throws → forbidden
 *     - happy path: ok:true, emits security.mfa_policy_updated, revalidates
 *     - internal error: DB throws → internal
 *   loadMfaPolicy:
 *     - returns null when no row exists
 *     - returns mfaRequired + mfaGraceHours when row exists
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
    insertError: Error | null;
    policyRows: Array<{ mfaRequired: boolean; mfaGraceHours: number }>;
  }
  const dbState: DbState = {
    insertError: null,
    policyRows: [{ mfaRequired: true, mfaGraceHours: 24 }],
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
  assertSecurityManager: mockAssertSecurityManager,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mockEmitSecurityEvent,
}));
vi.mock("@oxagen/database", () => {
  const makeTx = () => ({
    insert: (_table: unknown) => ({
      values: (_vals: unknown) => {
        if (dbState.insertError) throw dbState.insertError;
        return {
          onConflictDoUpdate: (_opts: unknown) => Promise.resolve(undefined),
        };
      },
    }),
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          limit: (_n: number) => Promise.resolve(dbState.policyRows),
        }),
      }),
    }),
  });
  return {
    withSystemDb: vi.fn((fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
      fn(makeTx()),
    ),
    schema: {
      orgSecurityPolicy: {
        orgId: "orgId_col",
        mfaRequired: "mfaRequired_col",
        mfaGraceHours: "mfaGraceHours_col",
      },
    },
  };
});
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: "eq" })),
}));

import { saveMfaPolicyAction, loadMfaPolicy } from "./actions";

const SESSION = { user: { id: "actor-1" } };
const ORG = { id: "org-1", slug: "acme" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("saveMfaPolicyAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.insertError = null;
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockAssertSecurityManager.mockResolvedValue(undefined);
  });

  it("returns validation_error when mfaGraceHours exceeds 720", async () => {
    const res = await saveMfaPolicyAction({
      orgSlug: "acme",
      mfaRequired: true,
      mfaGraceHours: 721,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("validation_error");
    expect(mockAssertSecurityManager).not.toHaveBeenCalled();
  });

  it("returns validation_error when mfaGraceHours is negative", async () => {
    const res = await saveMfaPolicyAction({
      orgSlug: "acme",
      mfaRequired: false,
      mfaGraceHours: -1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("validation_error");
  });

  it("returns forbidden when assertSecurityManager throws", async () => {
    mockAssertSecurityManager.mockRejectedValue(new Error("insufficient role"));
    const res = await saveMfaPolicyAction({
      orgSlug: "acme",
      mfaRequired: true,
      mfaGraceHours: 24,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("forbidden");
  });

  it("returns ok:true and emits security.mfa_policy_updated on success", async () => {
    const res = await saveMfaPolicyAction({
      orgSlug: "acme",
      mfaRequired: true,
      mfaGraceHours: 48,
    });
    expect(res.ok).toBe(true);
    expect(mockEmitSecurityEvent).toHaveBeenCalledOnce();
    const event = mockEmitSecurityEvent.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(event.eventType).toBe("security.mfa_policy_updated");
    expect(event.actorUserId).toBe("actor-1");
    expect(event.orgId).toBe("org-1");
    expect(event.outcome).toBe("success");
  });

  it("revalidates both the mfa page and the security index on success", async () => {
    await saveMfaPolicyAction({
      orgSlug: "acme",
      mfaRequired: false,
      mfaGraceHours: 0,
    });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/security/mfa");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/security");
  });

  it("returns internal error when the DB insert throws", async () => {
    dbState.insertError = new Error("DB connection lost");
    const res = await saveMfaPolicyAction({
      orgSlug: "acme",
      mfaRequired: true,
      mfaGraceHours: 24,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("internal");
    expect(mockEmitSecurityEvent).not.toHaveBeenCalled();
  });

  it("accepts mfaGraceHours=0 (immediate enforcement)", async () => {
    const res = await saveMfaPolicyAction({
      orgSlug: "acme",
      mfaRequired: true,
      mfaGraceHours: 0,
    });
    expect(res.ok).toBe(true);
  });

  it("accepts mfaGraceHours=720 (boundary max)", async () => {
    const res = await saveMfaPolicyAction({
      orgSlug: "acme",
      mfaRequired: true,
      mfaGraceHours: 720,
    });
    expect(res.ok).toBe(true);
  });
});

describe("loadMfaPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the policy row when it exists", async () => {
    dbState.policyRows = [{ mfaRequired: true, mfaGraceHours: 48 }];
    const result = await loadMfaPolicy("org-1");
    expect(result).toEqual({ mfaRequired: true, mfaGraceHours: 48 });
  });

  it("returns null when no policy row exists", async () => {
    dbState.policyRows = [];
    const result = await loadMfaPolicy("org-1");
    expect(result).toBeNull();
  });
});
