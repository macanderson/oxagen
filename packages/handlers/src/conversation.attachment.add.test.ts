import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The handler makes three withTenantDb calls in order:
//   1. conversation lookup   (select … limit)
//   2. asset lookup          (select … limit)
//   3. linkage update        (update … set … where)
const mocks = vi.hoisted(() => ({
  convSelect: vi.fn(),
  assetSelect: vi.fn(),
  updateWhere: vi.fn(),
  callCount: { value: 0 },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();

  const selectChain = (leaf: () => Promise<unknown>) => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: leaf,
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: mocks.updateWhere,
      }),
    }),
  });

  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      mocks.callCount.value += 1;
      const leaf =
        mocks.callCount.value === 1 ? mocks.convSelect : mocks.assetSelect;
      return fn(selectChain(leaf));
    },
  };
});

import { conversationAttachmentAddHandler } from "./conversation.attachment.add";
import { makeCTX } from "./test-utils/fixtures";

const INPUT = { conversationId: "cnv_abc", assetPublicId: "gen_abc123" };

const CONV_ROW = { id: "int-conv-id" };

const makeAssetRow = (overrides: Record<string, unknown> = {}) => ({
  id: "int-asset-id",
  publicId: "gen_abc123",
  kind: "image",
  mimeType: "image/png",
  sizeBytes: BigInt(204800),
  status: "ready",
  accessPolicy: "org",
  userId: "u_1",
  prompt: "",
  metadata: {},
  createdAt: new Date("2024-06-01T12:00:00.000Z"),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callCount.value = 0;
  mocks.convSelect.mockResolvedValue([CONV_ROW]);
  mocks.assetSelect.mockResolvedValue([makeAssetRow()]);
  mocks.updateWhere.mockResolvedValue(undefined);
});

describe("conversationAttachmentAddHandler (@oxagen/handlers)", () => {
  it("rejects when there is no authenticated user", async () => {
    await expect(
      conversationAttachmentAddHandler(INPUT, makeCTX({ userId: null })),
    ).rejects.toThrow(/authenticated user/);
  });

  it("throws when the conversation is not found or out of scope", async () => {
    mocks.convSelect.mockResolvedValueOnce([]);
    await expect(
      conversationAttachmentAddHandler(INPUT, makeCTX()),
    ).rejects.toThrow(/conversation not found/);
    // The asset lookup / update must not run.
    expect(mocks.updateWhere).not.toHaveBeenCalled();
  });

  it("throws when the asset is not found or out of scope", async () => {
    mocks.assetSelect.mockResolvedValueOnce([]);
    await expect(
      conversationAttachmentAddHandler(INPUT, makeCTX()),
    ).rejects.toThrow(/asset not found/);
    expect(mocks.updateWhere).not.toHaveBeenCalled();
  });

  it("throws when the asset is not ready", async () => {
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({ status: "pending" }),
    ]);
    await expect(
      conversationAttachmentAddHandler(INPUT, makeCTX()),
    ).rejects.toThrow(/not ready/);
    expect(mocks.updateWhere).not.toHaveBeenCalled();
  });

  it("throws when a user-private asset is not owned by the caller", async () => {
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({ accessPolicy: "user", userId: "someone-else" }),
    ]);
    await expect(
      conversationAttachmentAddHandler(INPUT, makeCTX()),
    ).rejects.toThrow(/asset not found/);
    expect(mocks.updateWhere).not.toHaveBeenCalled();
  });

  it("links the asset and returns the conversationAssetItem record", async () => {
    const result = await conversationAttachmentAddHandler(INPUT, makeCTX());

    // The linkage update ran.
    expect(mocks.updateWhere).toHaveBeenCalledTimes(1);

    expect(result).toMatchObject({
      publicId: "gen_abc123",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 204800,
      status: "ready",
      accessPolicy: "org",
      url: "/api/v1/assets/gen_abc123",
    });
    expect(result.createdAt).toBe("2024-06-01T12:00:00.000Z");
    // name is derived (slug + extension) — assert it carries the right extension.
    expect(result.name).toMatch(/\.png$/);
  });

  it("attaches an org-visible asset owned by another user", async () => {
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({ accessPolicy: "org", userId: "someone-else" }),
    ]);
    const result = await conversationAttachmentAddHandler(INPUT, makeCTX());
    expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
    expect(result.publicId).toBe("gen_abc123");
  });

  it("maps a null sizeBytes through to null", async () => {
    mocks.assetSelect.mockResolvedValueOnce([
      makeAssetRow({ sizeBytes: null }),
    ]);
    const result = await conversationAttachmentAddHandler(INPUT, makeCTX());
    expect(result.sizeBytes).toBeNull();
  });
});
