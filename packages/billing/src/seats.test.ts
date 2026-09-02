/**
 * Unit tests for packages/billing/src/seats.ts
 *
 * Covers:
 *  1. Free org (no subscription) → licenses = 1
 *  2. Active subscription with seatCount = 5 → licenses = 5
 *  3. Pending invitations count toward `used`
 *  4. Active users count toward `used`
 *  5. `available` is licenses − used, clamped at 0
 *  6. assertSeatAvailable passes when seats are free
 *  7. assertSeatAvailable throws SeatLimitError when used >= licenses
 *  8. isSeatLimitError type guard
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────────

const mockSelect = vi.fn();

const dbMocks = {
  select: mockSelect,
  query: {
    subscriptions: { findFirst: vi.fn() },
  },
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => dbMocks,
    withTenantDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
    withSystemDb: async (fn: (tx: typeof dbMocks) => unknown) => fn(dbMocks),
  };
});

// ── drizzle-orm mock ─────────────────────────────────────────────────────────
// The seats module uses `and`, `count`, `eq`, `sql` from drizzle-orm.
// We don't need to replicate their logic — the DB mock controls results.

// Import AFTER mocks.
const {
  getOrgSeatUsage,
  assertSeatAvailable,
  SeatLimitError,
  isSeatLimitError,
} = await import("./seats");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the mock chain for the three sequential `.select().from().where().limit(1)` calls
 * that seats.ts makes:
 *   [0] active subscription seatCount
 *   [1] count of org_users
 *   [2] count of pending invitations
 */
function mockSeatCounts({
  seatCount,
  activeUsers,
  pendingInvites,
}: {
  seatCount: number | undefined;
  activeUsers: number;
  pendingInvites: number;
}) {
  let callCount = 0;

  mockSelect.mockImplementation(() => {
    callCount++;
    const idx = callCount;

    const buildChain = () => ({
      from: () => buildChain(),
      innerJoin: () => buildChain(),
      where: () => buildChain(),
      limit: async () => {
        if (idx === 1) {
          return seatCount !== undefined ? [{ seatCount }] : [];
        }
        return []; // fallback
      },
    });

    // For count queries, the terminal `.where()` is the last method.
    // Since `count()` queries don't use `.limit()`, we resolve in `.where()`.
    if (idx === 2) {
      return {
        from: () => ({
          where: async () => [{ total: activeUsers }],
        }),
      };
    }
    if (idx === 3) {
      return {
        from: () => ({
          where: async () => [{ total: pendingInvites }],
        }),
      };
    }

    return buildChain();
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getOrgSeatUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("free org (no active subscription) → licenses = 1", async () => {
    mockSeatCounts({ seatCount: undefined, activeUsers: 1, pendingInvites: 0 });
    const usage = await getOrgSeatUsage("org-free");
    expect(usage.licenses).toBe(1);
    expect(usage.used).toBe(1);
    expect(usage.available).toBe(0);
  });

  it("active subscription with seatCount = 5 → licenses = 5", async () => {
    mockSeatCounts({ seatCount: 5, activeUsers: 2, pendingInvites: 0 });
    const usage = await getOrgSeatUsage("org-paid");
    expect(usage.licenses).toBe(5);
    expect(usage.used).toBe(2);
    expect(usage.available).toBe(3);
  });

  it("pending invitations count toward `used`", async () => {
    mockSeatCounts({ seatCount: 3, activeUsers: 1, pendingInvites: 2 });
    const usage = await getOrgSeatUsage("org-inviting");
    expect(usage.used).toBe(3); // 1 user + 2 pending
    expect(usage.available).toBe(0);
  });

  it("available is clamped at 0 when over-provisioned", async () => {
    // This shouldn't happen in practice but guard the math.
    mockSeatCounts({ seatCount: 1, activeUsers: 2, pendingInvites: 1 });
    const usage = await getOrgSeatUsage("org-overprovisioned");
    expect(usage.available).toBe(0);
  });
});

describe("assertSeatAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes (no throw) when a seat is free", async () => {
    mockSeatCounts({ seatCount: 2, activeUsers: 1, pendingInvites: 0 });
    await expect(assertSeatAvailable("org-has-seat")).resolves.toBeUndefined();
  });

  it("throws SeatLimitError when used === licenses", async () => {
    mockSeatCounts({ seatCount: 1, activeUsers: 1, pendingInvites: 0 });
    await expect(assertSeatAvailable("org-full")).rejects.toThrow(
      SeatLimitError,
    );
  });

  it("SeatLimitError has correct code, licenses, and used fields", async () => {
    mockSeatCounts({ seatCount: 2, activeUsers: 1, pendingInvites: 1 });
    let caught: unknown;
    try {
      await assertSeatAvailable("org-at-limit");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SeatLimitError);
    const e = caught as InstanceType<typeof SeatLimitError>;
    expect(e.code).toBe("seat_limit_reached");
    expect(e.licenses).toBe(2);
    expect(e.used).toBe(2);
  });

  it("throws SeatLimitError when used exceeds licenses (over-inviting)", async () => {
    mockSeatCounts({ seatCount: 1, activeUsers: 0, pendingInvites: 2 });
    await expect(assertSeatAvailable("org-over-limit")).rejects.toThrow(
      SeatLimitError,
    );
  });
});

describe("isSeatLimitError", () => {
  it("returns true for SeatLimitError instances", () => {
    const err = new SeatLimitError(2, 2);
    expect(isSeatLimitError(err)).toBe(true);
  });

  it("returns false for plain errors", () => {
    expect(isSeatLimitError(new Error("nope"))).toBe(false);
    expect(isSeatLimitError("string")).toBe(false);
    expect(isSeatLimitError(null)).toBe(false);
  });
});
