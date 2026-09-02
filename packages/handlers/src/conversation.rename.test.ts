import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  updateReturning: vi.fn(),
}));

mocks.updateReturning.mockResolvedValue([
  { publicId: "cnv_abc", title: "New Title" },
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

import { conversationRenameHandler } from "./conversation.rename";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

import { TEST_CTX as CTX } from "./test-utils/fixtures";

const BASE_INPUT = {
  conversationId: "cnv_abc",
  title: "New Title",
};

describe("conversationRenameHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateReturning.mockResolvedValue([
      { publicId: "cnv_abc", title: "New Title" },
    ]);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      conversationRenameHandler(BASE_INPUT, anonCtx),
    ).rejects.toThrow("conversation.rename requires an authenticated user");
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns publicId and title on success", async () => {
    const result = await conversationRenameHandler(BASE_INPUT, CTX);
    expect(result.publicId).toBe("cnv_abc");
    expect(result.title).toBe("New Title");
  });

  it("calls the update returning exactly once", async () => {
    await conversationRenameHandler(BASE_INPUT, CTX);
    expect(mocks.updateReturning).toHaveBeenCalledTimes(1);
  });

  // ── not found ─────────────────────────────────────────────────────────────

  it("throws 'conversation not found' when update returns no rows", async () => {
    mocks.updateReturning.mockResolvedValueOnce([]);
    await expect(conversationRenameHandler(BASE_INPUT, CTX)).rejects.toThrow(
      "conversation.rename: conversation not found",
    );
  });

  // ── tenant scope (wrong org/ws/user returns empty) ────────────────────────

  it("throws when update returns empty rows (cross-tenant scenario returns no match)", async () => {
    mocks.updateReturning.mockResolvedValueOnce([]);
    const otherCtx: CapabilityContext = { ...CTX, orgId: "org_other" };
    await expect(
      conversationRenameHandler(BASE_INPUT, otherCtx),
    ).rejects.toThrow("conversation.rename: conversation not found");
  });
});
