import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  updateReturning: vi.fn(),
}));

mocks.updateReturning.mockResolvedValue([
  { publicId: "cnv_1" },
  { publicId: "cnv_2" },
  { publicId: "cnv_3" },
]);

vi.mock("@oxagen/database", () => ({
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
  schema: {
    conversations: {
      publicId: "publicId",
      orgId: "orgId",
      workspaceId: "workspaceId",
      userId: "userId",
      deletedAt: "deletedAt",
      deletedByUserId: "deletedByUserId",
      archivedAt: "archivedAt",
      updatedAt: "updatedAt",
      updatedByUserId: "updatedByUserId",
    },
  },
}));

import { conversationPurgeHandler } from "./conversation.purge";
import type { CapabilityContext } from "@oxagen/oxagen";

// ─────────────────────────────────────────────────────────────────────────────

const CTX: CapabilityContext = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

describe("conversationPurgeHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateReturning.mockResolvedValue([
      { publicId: "cnv_1" },
      { publicId: "cnv_2" },
      { publicId: "cnv_3" },
    ]);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(conversationPurgeHandler({}, anonCtx)).rejects.toThrow(
      "conversation.purge requires an authenticated user",
    );
  });

  // ── happy path ────────────────────────────────────────────────────────────

  it("returns deleted count equal to number of archived rows purged", async () => {
    const result = await conversationPurgeHandler({}, CTX);
    expect(result.deleted).toBe(3);
  });

  it("returns deleted=0 when there are no archived conversations to purge", async () => {
    mocks.updateReturning.mockResolvedValueOnce([]);
    const result = await conversationPurgeHandler({}, CTX);
    expect(result.deleted).toBe(0);
  });

  // ── takes no ids ─────────────────────────────────────────────────────────

  it("accepts an empty input object (no conversationIds needed)", async () => {
    const result = await conversationPurgeHandler({}, CTX);
    expect(result).toHaveProperty("deleted");
  });

  // ── DB called once ────────────────────────────────────────────────────────

  it("invokes the update returning exactly once", async () => {
    await conversationPurgeHandler({}, CTX);
    expect(mocks.updateReturning).toHaveBeenCalledTimes(1);
  });
});
