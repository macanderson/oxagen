/**
 * Unit tests for org.member.add handler.
 *
 * Mocks:
 *  - @oxagen/database → db() + schema
 *  - @oxagen/billing  → assertSeatAvailable, isSeatLimitError, SeatLimitError
 *
 * Scenarios:
 *  1. No authenticated principal → throws Unauthorized
 *  2. No orgId → throws Forbidden
 *  3. Seat limit reached → re-throws SeatLimitError
 *  4. Duplicate pending invitation (Postgres 23505) → friendly error
 *  5. Happy path → returns pending invitation shape
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── @oxagen/billing mock ─────────────────────────────────────────────────────

const mockAssertSeatAvailable = vi.fn();

// Import the real SeatLimitError so instanceof checks work.
const { SeatLimitError } = await import("@oxagen/billing");

vi.mock("@oxagen/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...actual,
    assertSeatAvailable: mockAssertSeatAvailable,
  };
});

// ── @oxagen/database mock ────────────────────────────────────────────────────

const mockInsert = vi.fn();
// The caller's org membership, read by the Owner/Admin guard. Owner by default;
// a test that wants a non-privileged caller overwrites it.
const mockMembershipRows = vi.fn(() => [{ role: "owner" }]);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({
      insert: mockInsert,
    }),
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ insert: mockInsert }),
    withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => mockMembershipRows() }),
          }),
        }),
      }),
  };
});

// ── drizzle-orm mock ─────────────────────────────────────────────────────────

const { orgMemberAddHandler } = await import("./org.member.add");

// ── Fixture ──────────────────────────────────────────────────────────────────

function makeCtx(overrides: Record<string, unknown> = {}): CapabilityContext {
  return {
    userId: "user-123",
    apiKeyId: null,
    orgId: "org-abc",
    workspaceId: "ws-abc",
    surface: "api",
    planTier: "build",
    ...overrides,
  } as CapabilityContext;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("orgMemberAddHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no authenticated principal → throws Unauthorized", async () => {
    const ctx = makeCtx({ userId: null, apiKeyId: null });
    await expect(
      orgMemberAddHandler({ email: "a@b.com", role: "Member" }, ctx),
    ).rejects.toThrow("Unauthorized");
    expect(mockAssertSeatAvailable).not.toHaveBeenCalled();
  });

  it("no orgId → throws Forbidden", async () => {
    const ctx = makeCtx({ orgId: null });
    await expect(
      orgMemberAddHandler({ email: "a@b.com", role: "Member" }, ctx),
    ).rejects.toThrow("Forbidden");
    expect(mockAssertSeatAvailable).not.toHaveBeenCalled();
  });

  it("seat limit reached → re-throws SeatLimitError with correct code", async () => {
    mockAssertSeatAvailable.mockRejectedValue(new SeatLimitError(1, 1));
    const ctx = makeCtx();
    let caught: unknown;
    try {
      await orgMemberAddHandler({ email: "a@b.com", role: "Member" }, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SeatLimitError);
    expect((caught as InstanceType<typeof SeatLimitError>).code).toBe(
      "seat_limit_reached",
    );
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("duplicate pending invite (Postgres 23505) → friendly error message", async () => {
    mockAssertSeatAvailable.mockResolvedValue(undefined);
    const pgConflict = Object.assign(new Error("unique violation"), {
      code: "23505",
    });
    // The handler calls db().insert(...).values(...)
    // Simulate the conflict on returning().
    const returningMock = vi.fn().mockRejectedValue(pgConflict);
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: returningMock }),
    });

    const ctx = makeCtx();
    await expect(
      orgMemberAddHandler({ email: "a@b.com", role: "Member" }, ctx),
    ).rejects.toThrow("pending invitation for a@b.com already exists");
  });

  it("happy path → returns pending invitation with correct shape", async () => {
    mockAssertSeatAvailable.mockResolvedValue(undefined);
    const expiresAt = new Date(Date.now() + 86400 * 1000);
    const returningMock = vi
      .fn()
      .mockResolvedValue([{ publicId: "inv_TEST01", expiresAt }]);
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: returningMock }),
    });

    const ctx = makeCtx();
    const result = await orgMemberAddHandler(
      { email: "alice@example.com", role: "Admin" },
      ctx,
    );

    expect(result).toMatchObject({
      invitationId: "inv_TEST01",
      email: "alice@example.com",
      role: "Admin",
      status: "pending",
    });
    expect(typeof result.expiresAt).toBe("string");
  });

  it("happy path with null expiresAt → expiresAt is null in output", async () => {
    mockAssertSeatAvailable.mockResolvedValue(undefined);
    const returningMock = vi
      .fn()
      .mockResolvedValue([{ publicId: "inv_TEST02", expiresAt: null }]);
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: returningMock }),
    });

    const ctx = makeCtx();
    const result = await orgMemberAddHandler(
      { email: "bob@example.com", role: "Member" },
      ctx,
    );

    expect(result.expiresAt).toBeNull();
  });
  // ── Role guard ─────────────────────────────────────────────────────────────
  //
  // `role` is a free string on the wire and the kernel's IAM gate consults no
  // policy for an org below the tier that unlocks ACLs, so without this guard
  // any member could invite an accomplice — or a second address of their own —
  // as "owner" and take the org.

  it("refuses a caller who is not an org Owner or Admin", async () => {
    mockAssertSeatAvailable.mockResolvedValue(undefined);
    mockMembershipRows.mockReturnValueOnce([{ role: "member" }]);

    await expect(
      orgMemberAddHandler(
        { email: "accomplice@example.com", role: "owner" },
        makeCtx(),
      ),
    ).rejects.toThrow("Forbidden: inviting a member requires Owner or Admin");
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("refuses a caller with no membership row at all", async () => {
    mockAssertSeatAvailable.mockResolvedValue(undefined);
    mockMembershipRows.mockReturnValueOnce([]);

    await expect(
      orgMemberAddHandler(
        { email: "accomplice@example.com", role: "owner" },
        makeCtx(),
      ),
    ).rejects.toThrow("Forbidden: inviting a member requires Owner or Admin");
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("accepts a TitleCase membership role — the column carries both casings", async () => {
    mockAssertSeatAvailable.mockResolvedValue(undefined);
    mockMembershipRows.mockReturnValueOnce([{ role: "Admin" }]);
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([{ publicId: "inv_TEST03", expiresAt: null }]),
      }),
    });

    const result = await orgMemberAddHandler(
      { email: "bob@example.com", role: "Member" },
      makeCtx(),
    );

    expect(result.status).toBe("pending");
  });
});
