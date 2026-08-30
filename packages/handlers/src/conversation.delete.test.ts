import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  updateReturning: vi.fn(),
}));

mocks.updateReturning.mockResolvedValue([
  { publicId: "cnv_1" },
  { publicId: "cnv_2" },
]);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({
      update: (_table: unknown) => ({
        set: (_vals: unknown) => ({
          where: (_cond: unknown) => ({
            returning: mocks.updateReturning,
          }),
        }),
      }),
    }),
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        update: (_table: unknown) => ({
          set: (_vals: unknown) => ({
            where: (_cond: unknown) => ({
              returning: mocks.updateReturning,
            }),
          }),
        }),
      }),
  };
});

import { conversationDeleteHandler } from "./conversation.delete";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("conversationDeleteHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateReturning.mockResolvedValue([
      { publicId: "cnv_1" },
      { publicId: "cnv_2" },
    ]);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      conversationDeleteHandler({ conversationIds: ["cnv_1"] }, anonCtx),
    ).rejects.toThrow("conversation.delete requires an authenticated user");
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns deleted count matching rows affected", async () => {
    const result = await conversationDeleteHandler(
      { conversationIds: ["cnv_1", "cnv_2"] },
      CTX,
    );
    expect(result.deleted).toBe(2);
  });

  it("returns 0 when no rows match (already deleted or wrong tenant)", async () => {
    mocks.updateReturning.mockResolvedValueOnce([]);
    const result = await conversationDeleteHandler(
      { conversationIds: ["cnv_missing"] },
      CTX,
    );
    expect(result.deleted).toBe(0);
  });

  it("returns deleted=1 for a single matching conversation", async () => {
    mocks.updateReturning.mockResolvedValueOnce([{ publicId: "cnv_1" }]);
    const result = await conversationDeleteHandler(
      { conversationIds: ["cnv_1"] },
      CTX,
    );
    expect(result.deleted).toBe(1);
  });

  // ── tenant scope ──────────────────────────────────────────────────────────

  it("returns 0 when the conversation belongs to a different tenant (update hits 0 rows)", async () => {
    mocks.updateReturning.mockResolvedValueOnce([]);
    const otherCtx: CapabilityContext = { ...CTX, orgId: "org_other" };
    const result = await conversationDeleteHandler(
      { conversationIds: ["cnv_1"] },
      otherCtx,
    );
    expect(result.deleted).toBe(0);
  });

  // ── DB called once ────────────────────────────────────────────────────────

  it("invokes the update returning exactly once", async () => {
    await conversationDeleteHandler({ conversationIds: ["cnv_1"] }, CTX);
    expect(mocks.updateReturning).toHaveBeenCalledTimes(1);
  });
});
