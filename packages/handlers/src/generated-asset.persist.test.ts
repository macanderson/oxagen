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
  // resolveConversationId's message lookup: tx.select().from().where().limit().
  msgSelect: vi.fn(),
}));

vi.mock("@oxagen/storage", () => ({
  storage: () => ({ driver: "vercel-blob", put: mocks.put }),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // A fake tx exposing both the insert chain (the asset row) and a select chain
  // (resolveConversationId's message → conversation lookup).
  const tx = {
    insert: mocks.insert,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.msgSelect,
        }),
      }),
    }),
  };
  return {
    ...real,
    db: () => tx,
    // withSystemDb passthrough: the handler uses withSystemDb for both
    // persistGeneratedAsset and createPendingGeneratedAsset inserts.
    // Forward fn to a fake tx that exposes the insert + select mocks.
    withSystemDb: async (
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
    ) => fn(tx as unknown as Record<string, unknown>),
  };
});

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
  mocks.returning.mockResolvedValue([
    { id: "asset-uuid", publicId: "gen_ABC" },
  ]);
  mocks.values.mockReturnValue({ returning: mocks.returning });
  mocks.insert.mockReturnValue({ values: mocks.values });
  // Default: no message row → resolveConversationId returns null.
  mocks.msgSelect.mockResolvedValue([]);
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
    expect(row.storageUrl).toBe(
      "https://private.blob.vercel-storage.com/x.png?token=x",
    );
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
    expect(out.key).toBe(
      "generated/images/org-1/11111111-1111-1111-1111-111111111111.png",
    );
  });

  it("defaults source to 'generated' when not supplied", async () => {
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.source).toBe("generated");
  });

  it("passes through source: 'user_upload' (the asset.upload attachment path)", async () => {
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      accessPolicy: "org",
      prompt: "",
      model: "",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      source: "user_upload",
      conversationId: "conv-1",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.source).toBe("user_upload");
    expect(row.accessPolicy).toBe("org");
    expect(row.prompt).toBe("");
    expect(row.model).toBe("");
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

describe("displayName → metadata", () => {
  it("stores a clean displayName under metadata.displayName", async () => {
    await persistGeneratedAsset({
      ...BASE,
      kind: "document",
      bytes: new Uint8Array([1]),
      mimeType: "text/markdown",
      displayName: "USS Nautilus Polar Crossing",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.metadata).toEqual({
      displayName: "USS Nautilus Polar Crossing",
    });
  });

  it("leaves metadata undefined when no displayName is supplied", async () => {
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.metadata).toBeUndefined();
  });

  it("trims and ignores a blank displayName", async () => {
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      displayName: "   ",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.metadata).toBeUndefined();
  });

  it("stores displayName for a pending (video) asset too", async () => {
    const { createPendingGeneratedAsset } = await import(
      "./generated-asset.persist"
    );
    await createPendingGeneratedAsset({
      ...BASE,
      kind: "video",
      accessPolicy: "org",
      mimeType: "video/mp4",
      displayName: "Arctic Transit Animation",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.metadata).toEqual({ displayName: "Arctic Transit Animation" });
  });
});

describe("conversation linkage (resolveConversationId)", () => {
  it("uses an explicit conversationId without a message lookup", async () => {
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      conversationId: "conv-explicit",
      messageId: "msg-1",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.conversationId).toBe("conv-explicit");
    // An explicit conversationId short-circuits — the message lookup is skipped.
    expect(mocks.msgSelect).not.toHaveBeenCalled();
  });

  it("resolves conversationId from the message when only messageId is given", async () => {
    // The agent-tool generators (image.create/video.generate/documents) carry
    // only messageId — the panel filter is on conversation_id, so we backfill it.
    mocks.msgSelect.mockResolvedValueOnce([
      { conversationId: "conv-from-msg" },
    ]);
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      messageId: "msg-42",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mocks.msgSelect).toHaveBeenCalledTimes(1);
    expect(row.conversationId).toBe("conv-from-msg");
    expect(row.messageId).toBe("msg-42");
  });

  it("resolves a public 'cnv_…' conversationId to the internal UUID (composer upload path)", async () => {
    // Regression: the composer upload route forwards the client-facing public
    // id; inserting it raw into the uuid column 500'd every upload made while
    // a conversation was active.
    mocks.msgSelect.mockResolvedValueOnce([{ id: "conv-uuid-from-public" }]);
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      conversationId: "cnv_9e49p5ne9bdmef5x57tsvw",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mocks.msgSelect).toHaveBeenCalledTimes(1);
    expect(row.conversationId).toBe("conv-uuid-from-public");
  });

  it("drops the linkage (never throws) when a public id matches no org conversation", async () => {
    // Org-scoped resolution: a forged/foreign "cnv_…" id resolves to nothing,
    // so the asset persists unlinked instead of linking cross-org or failing.
    mocks.msgSelect.mockResolvedValueOnce([]);
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      conversationId: "cnv_not_in_this_org",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.conversationId).toBeUndefined();
  });

  it("leaves conversationId undefined when neither id is supplied", async () => {
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.conversationId).toBeUndefined();
    expect(mocks.msgSelect).not.toHaveBeenCalled();
  });

  it("leaves conversationId undefined when the message has no conversation", async () => {
    mocks.msgSelect.mockResolvedValueOnce([]); // message not found / no conversation
    await persistGeneratedAsset({
      ...BASE,
      kind: "image",
      bytes: new Uint8Array([1]),
      mimeType: "image/png",
      messageId: "msg-orphan",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(mocks.msgSelect).toHaveBeenCalledTimes(1);
    expect(row.conversationId).toBeUndefined();
  });

  it("resolves conversationId from messageId for a pending (video) asset too", async () => {
    mocks.msgSelect.mockResolvedValueOnce([{ conversationId: "conv-video" }]);
    const { createPendingGeneratedAsset } = await import(
      "./generated-asset.persist"
    );
    await createPendingGeneratedAsset({
      ...BASE,
      kind: "video",
      accessPolicy: "org",
      mimeType: "video/mp4",
      messageId: "msg-vid",
    });
    const row = mocks.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.conversationId).toBe("conv-video");
    expect(row.messageId).toBe("msg-vid");
  });
});

describe("createPendingGeneratedAsset", () => {
  it("inserts a pending row with no blob yet and returns the serving URL", async () => {
    const { createPendingGeneratedAsset } = await import(
      "./generated-asset.persist"
    );
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
