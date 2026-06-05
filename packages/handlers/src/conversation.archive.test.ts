import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  updateReturning: vi.fn(),
}));

mocks.updateReturning.mockResolvedValue([{ publicId: "cnv_1" }, { publicId: "cnv_2" }]);

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
  schema: {
    conversations: {
      publicId: "publicId",
      orgId: "orgId",
      workspaceId: "workspaceId",
      userId: "userId",
      deletedAt: "deletedAt",
      archivedAt: "archivedAt",
      archivedByUserId: "archivedByUserId",
      updatedAt: "updatedAt",
      updatedByUserId: "updatedByUserId",
    },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const orig = await importOriginal<typeof import("drizzle-orm")>();
  return { and: orig.and, eq: orig.eq, inArray: orig.inArray, isNull: orig.isNull };
});

import { conversationArchiveHandler } from "./conversation.archive";
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

describe("conversationArchiveHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateReturning.mockResolvedValue([{ publicId: "cnv_1" }, { publicId: "cnv_2" }]);
  });

  // ── auth guard ────────────────────────────────────────────────────────────

  it("throws when userId is null", async () => {
    const anonCtx: CapabilityContext = { ...CTX, userId: null };
    await expect(
      conversationArchiveHandler({ conversationIds: ["cnv_1"], archived: true }, anonCtx),
    ).rejects.toThrow("conversation.archive requires an authenticated user");
  });

  // ── archive happy path ────────────────────────────────────────────────────

  it("returns updated count matching the number of rows affected", async () => {
    const result = await conversationArchiveHandler(
      { conversationIds: ["cnv_1", "cnv_2"], archived: true },
      CTX,
    );
    expect(result.updated).toBe(2);
  });

  it("returns 0 when no rows match (already deleted / wrong tenant)", async () => {
    mocks.updateReturning.mockResolvedValueOnce([]);
    const result = await conversationArchiveHandler(
      { conversationIds: ["cnv_missing"], archived: true },
      CTX,
    );
    expect(result.updated).toBe(0);
  });

  // ── unarchive (archived=false) ────────────────────────────────────────────

  it("returns updated count when unarchiving", async () => {
    mocks.updateReturning.mockResolvedValueOnce([{ publicId: "cnv_1" }]);
    const result = await conversationArchiveHandler(
      { conversationIds: ["cnv_1"], archived: false },
      CTX,
    );
    expect(result.updated).toBe(1);
  });

  // ── DB is called ──────────────────────────────────────────────────────────

  it("invokes the update returning exactly once per call", async () => {
    await conversationArchiveHandler({ conversationIds: ["cnv_1"], archived: true }, CTX);
    expect(mocks.updateReturning).toHaveBeenCalledTimes(1);
  });
});
