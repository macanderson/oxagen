import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  selectFrom: vi.fn(),
}));

// selectFrom returns the full drizzle query-builder chain:
// .select().from().where().orderBy().limit()
mocks.selectFrom.mockResolvedValue([]);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: mocks.selectFrom,
            }),
          }),
        }),
      }),
    }),
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: mocks.selectFrom,
              }),
            }),
          }),
        }),
      }),
  };
});

import { conversationListHandler } from "./conversation.list";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const BASE_INPUT = {
  filter: "active" as const,
  limit: 50,
  cursor: null,
};

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  publicId: "cnv_abc",
  title: "My conversation",
  status: "active",
  archivedAt: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-02T00:00:00.000Z"),
  ...overrides,
});

describe("conversationListHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectFrom.mockResolvedValue([]);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(conversationListHandler(BASE_INPUT, anonCtx)).rejects.toThrow(
      "conversation.list requires an authenticated user",
    );
  });

  // ── empty result ──────────────────────────────────────────────────────────

  it("returns empty conversations array and null nextCursor when no rows", async () => {
    mocks.selectFrom.mockResolvedValueOnce([]);
    const result = await conversationListHandler(BASE_INPUT, CTX);
    expect(result.conversations).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("maps rows to ConversationSummary shape", async () => {
    const row = makeRow();
    mocks.selectFrom.mockResolvedValueOnce([row]);
    const result = await conversationListHandler(BASE_INPUT, CTX);

    expect(result.conversations).toHaveLength(1);
    const conv = result.conversations[0]!;
    expect(conv.publicId).toBe("cnv_abc");
    expect(conv.title).toBe("My conversation");
    expect(conv.status).toBe("active");
    expect(conv.archivedAt).toBeNull();
    expect(conv.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(conv.updatedAt).toBe("2024-01-02T00:00:00.000Z");
  });

  it("maps archivedAt to ISO string when set", async () => {
    const row = makeRow({ archivedAt: new Date("2024-06-01T12:00:00.000Z") });
    mocks.selectFrom.mockResolvedValueOnce([row]);
    const result = await conversationListHandler(BASE_INPUT, CTX);
    expect(result.conversations[0]!.archivedAt).toBe(
      "2024-06-01T12:00:00.000Z",
    );
  });

  it("coerces null title to null", async () => {
    const row = makeRow({ title: null });
    mocks.selectFrom.mockResolvedValueOnce([row]);
    const result = await conversationListHandler(BASE_INPUT, CTX);
    expect(result.conversations[0]!.title).toBeNull();
  });

  // ── pagination ────────────────────────────────────────────────────────────

  it("returns nextCursor when rows.length > limit", async () => {
    // With limit=2, we fetch limit+1=3 rows; if 3 rows come back, cursor is rows[1].updatedAt
    const rows = [
      makeRow({
        publicId: "cnv_1",
        updatedAt: new Date("2024-01-03T00:00:00.000Z"),
      }),
      makeRow({
        publicId: "cnv_2",
        updatedAt: new Date("2024-01-02T00:00:00.000Z"),
      }),
      makeRow({
        publicId: "cnv_3",
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      }),
    ];
    mocks.selectFrom.mockResolvedValueOnce(rows);

    const result = await conversationListHandler(
      { ...BASE_INPUT, limit: 2 },
      CTX,
    );

    // Only the first 2 rows are returned, not the extra
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0]!.publicId).toBe("cnv_1");
    expect(result.conversations[1]!.publicId).toBe("cnv_2");
    // nextCursor = rows[limit-1].updatedAt = rows[1].updatedAt
    expect(result.nextCursor).toBe("2024-01-02T00:00:00.000Z");
  });

  it("returns null nextCursor when rows.length <= limit (last page)", async () => {
    const rows = [makeRow({ publicId: "cnv_1" })];
    mocks.selectFrom.mockResolvedValueOnce(rows);

    const result = await conversationListHandler(
      { ...BASE_INPUT, limit: 2 },
      CTX,
    );
    expect(result.conversations).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  // ── tenant scope ──────────────────────────────────────────────────────────

  it("invokes the query builder (tenant-scope filters applied by the chain)", async () => {
    await conversationListHandler(BASE_INPUT, CTX);
    expect(mocks.selectFrom).toHaveBeenCalledTimes(1);
  });
});
