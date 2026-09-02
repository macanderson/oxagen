import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectWhere: vi.fn(),
}));

mocks.selectWhere.mockResolvedValue([]);

// Build a fake drizzle query chain:
// .select().from().innerJoin().where()
const makeTx = () => ({
  select: () => ({
    from: () => ({
      innerJoin: () => ({
        where: mocks.selectWhere,
      }),
    }),
  }),
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (
      fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>,
    ) => fn(makeTx()),
  };
});

import { workspaceMemberListHandler } from "./workspace.member.list";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  publicId: "wsu_abc",
  email: "alice@example.com",
  role: "Member",
  joinedAt: new Date("2024-01-15T00:00:00.000Z"),
  ...overrides,
});

describe("workspaceMemberListHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectWhere.mockResolvedValue([]);
  });

  it("returns empty array when no rows exist", async () => {
    mocks.selectWhere.mockResolvedValueOnce([]);
    const result = await workspaceMemberListHandler({}, CTX);
    expect(result).toEqual([]);
  });

  it("maps DB rows to the contract output shape", async () => {
    mocks.selectWhere.mockResolvedValueOnce([makeRow()]);
    const result = await workspaceMemberListHandler({}, CTX);

    expect(result).toHaveLength(1);
    const member = result[0]!;
    expect(member.id).toBe("wsu_abc");
    expect(member.email).toBe("alice@example.com");
    expect(member.role).toBe("Member");
    expect(member.joined_at).toBe("2024-01-15T00:00:00.000Z");
  });

  it("returns multiple members in order received", async () => {
    mocks.selectWhere.mockResolvedValueOnce([
      makeRow({ publicId: "wsu_1", email: "alice@example.com" }),
      makeRow({ publicId: "wsu_2", email: "bob@example.com", role: "Admin" }),
    ]);
    const result = await workspaceMemberListHandler({}, CTX);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("wsu_1");
    expect(result[1]!.id).toBe("wsu_2");
    expect(result[1]!.role).toBe("Admin");
  });

  it("invokes the query builder once (confirms tenant-scoped path)", async () => {
    await workspaceMemberListHandler({}, CTX);
    expect(mocks.selectWhere).toHaveBeenCalledTimes(1);
  });

  // ── error paths ───────────────────────────────────────────────────────────

  it("propagates DB error when the query rejects", async () => {
    mocks.selectWhere.mockRejectedValueOnce(new Error("DB connection failed"));

    await expect(workspaceMemberListHandler({}, CTX)).rejects.toThrow(
      "DB connection failed",
    );
  });

  it("throws when joinedAt is null (non-nullable field returned as null)", async () => {
    // The handler calls r.joinedAt.toISOString() without a null guard.
    // A corrupted DB row where joinedAt is null surfaces as a TypeError.
    mocks.selectWhere.mockResolvedValueOnce([makeRow({ joinedAt: null })]);

    await expect(workspaceMemberListHandler({}, CTX)).rejects.toThrow(
      TypeError,
    );
  });
});
