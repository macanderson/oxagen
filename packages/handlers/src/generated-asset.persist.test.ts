/**
 * Unit tests for persistGeneratedAsset (generated-asset.persist.ts).
 *
 * Mocks @oxagen/storage (put), @oxagen/database (insert chain), node:crypto.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  returning: vi.fn(),
}));

vi.mock("@oxagen/storage", () => ({
  storage: () => ({ driver: "vercel-blob", put: mocks.put }),
}));

vi.mock("@oxagen/database", () => ({
  db: () => ({ insert: mocks.insert }),
  schema: { generatedAssets: { id: "ga.id", publicId: "ga.publicId" } },
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "11111111-1111-1111-1111-111111111111",
}));

const { persistGeneratedAsset } = await import("./generated-asset.persist");

const BASE = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  prompt: "a calico cat",
  model: "openai/gpt-image-1",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.put.mockResolvedValue({
    url: "https://private.blob.vercel-storage.com/x.png?token=x",
    key: "generated/images/org-1/11111111-1111-1111-1111-111111111111.png",
    bytes: 2048,
    access: "private",
  });
  mocks.returning.mockResolvedValue([{ id: "asset-uuid", publicId: "gen_ABC" }]);
  mocks.values.mockReturnValue({ returning: mocks.returning });
  mocks.insert.mockReturnValue({ values: mocks.values });
});

describe("persistGeneratedAsset", () => {
  it("uploads bytes to a kind/org-scoped key as a PRIVATE object (SOC2 blob privacy)", async () => {
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
    });

    expect(mocks.put).toHaveBeenCalledTimes(1);
    const putArg = mocks.put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(putArg.key).toBe(
      "generated/images/org-1/11111111-1111-1111-1111-111111111111.png",
    );
    expect(putArg.contentType).toBe("image/png");
    // Must be private — the CDN URL must never be publicly guessable.
    // Bytes are served exclusively through the auth-gated /api/v1/assets proxy.
    expect(putArg.access).toBe("private");
  });

  it("defaults accessPolicy to `user` (private) and status to `ready`", async () => {
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
    });

    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.accessPolicy).toBe("user");
    expect(row.status).toBe("ready");
    expect(row.storageProvider).toBe("vercel-blob");
    expect(row.userId).toBe("user-1");
    expect(row.createdByUserId).toBe("user-1");
    // sizeBytes is persisted as a bigint from the storage byte count.
    expect(row.sizeBytes).toBe(BigInt(2048));
    // storageUrl is the private blob URL (not a public CDN URL).
    expect(row.storageUrl).toBe("https://private.blob.vercel-storage.com/x.png?token=x");
  });

  it("opts an asset up to the `org` policy when requested (the chat path)", async () => {
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      accessPolicy: "org",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      conversationId: "conv-1",
      messageId: "msg-1",
    });

    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.accessPolicy).toBe("org");
    expect(row.conversationId).toBe("conv-1");
    expect(row.messageId).toBe("msg-1");
  });

  it("maps the video MIME type to an .mp4 key extension", async () => {
    mocks.put.mockResolvedValue({
      url: "https://store/x.mp4",
      key: "generated/videos/org-1/11111111-1111-1111-1111-111111111111.mp4",
      bytes: 9000,
    });
    await persistGeneratedAsset({
      ...BASE,
      kind: "video",
      bytes: new Uint8Array([1]),
      mimeType: "video/mp4",
    });
    const putArg = mocks.put.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(putArg.key).toBe(
      "generated/videos/org-1/11111111-1111-1111-1111-111111111111.mp4",
    );
  });

  it("returns the public id and the access-controlled serving URL", async () => {
    const out = await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
    });
    expect(out.publicId).toBe("gen_ABC");
    expect(out.serveUrl).toBe("/api/v1/assets/gen_ABC");
    expect(out.sizeBytes).toBe(2048);
  });

  it("throws when the insert returns no row", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await expect(
      persistGeneratedAsset({
        ...BASE,
        kind: "image",
        bytes: new Uint8Array([1]),
        mimeType: "image/png",
      }),
    ).rejects.toThrow("generated_assets insert failed");
  });
});

describe("createPendingGeneratedAsset", () => {
  it("inserts a pending row with no blob yet and returns the serving URL", async () => {
    const { createPendingGeneratedAsset } = await import("./generated-asset.persist");
    const out = await createPendingGeneratedAsset({
      ...BASE,
      kind: "video",
      accessPolicy: "org",
      mimeType: "video/mp4",
      conversationId: "conv-1",
      messageId: "msg-1",
    });

    // No upload happens up front for an async render.
    expect(mocks.put).not.toHaveBeenCalled();

    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.kind).toBe("video");
    expect(row.accessPolicy).toBe("org");
    expect(row.storageKey).toBe("");
    expect(row.mimeType).toBe("video/mp4");
    expect(row.storageUrl).toBeUndefined();
    expect(row.sizeBytes).toBeUndefined();

    expect(out.id).toBe("asset-uuid");
    expect(out.publicId).toBe("gen_ABC");
    expect(out.serveUrl).toBe("/api/v1/assets/gen_ABC");
  });
});
