/**
 * attachments.test.ts — unit tests for resolveAttachmentImages.
 *
 * Covers:
 *   - empty publicIds short-circuits without touching the DB
 *   - resolves matching rows to fetched bytes, keyed by publicId
 *   - an id absent from the DB result set is simply absent from the map
 *     (caller decides hard-error vs. silent-degrade)
 *   - fetches through the private storage adapter (never a public URL)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWithTenantDb, mockRunInTenantScope, mockStorageGet, dbState } = vi.hoisted(() => ({
  mockWithTenantDb: vi.fn(),
  mockRunInTenantScope: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
  mockStorageGet: vi.fn(),
  dbState: { rows: [] as Array<{ publicId: string; storageKey: string; mimeType: string }> },
}));

vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/storage", () => ({ storage: () => ({ get: mockStorageGet }) }));
vi.mock("@oxagen/database", () => ({
  withTenantDb: mockWithTenantDb,
  schema: {
    generatedAssets: {
      publicId: "publicId_col",
      storageKey: "storageKey_col",
      mimeType: "mimeType_col",
      orgId: "orgId_col",
      workspaceId: "workspaceId_col",
      status: "status_col",
      kind: "kind_col",
      deletedAt: "deletedAt_col",
    },
  },
}));

import { resolveAttachmentImages } from "./attachments";

function fakeStream(bytes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRunInTenantScope.mockImplementation((_scope: unknown, fn: () => unknown) => fn());
  dbState.rows = [];
  mockWithTenantDb.mockImplementation((fn: (tx: unknown) => unknown) => {
    const tx = {
      select: (_cols: unknown) => ({
        from: (_table: unknown) => ({
          where: (_w: unknown) => Promise.resolve(dbState.rows),
        }),
      }),
    };
    return fn(tx);
  });
  mockStorageGet.mockResolvedValue({
    body: fakeStream([1, 2, 3, 4]),
    contentType: "image/png",
    sizeBytes: 4,
  });
});

const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };

describe("resolveAttachmentImages", () => {
  it("returns an empty map without touching the DB when publicIds is empty", async () => {
    const result = await resolveAttachmentImages([], SCOPE);
    expect(result.size).toBe(0);
    expect(mockWithTenantDb).not.toHaveBeenCalled();
  });

  it("resolves a matching row to its fetched bytes, keyed by publicId", async () => {
    dbState.rows = [
      { publicId: "gen_abc", storageKey: "generated/images/org-1/uuid.png", mimeType: "image/png" },
    ];

    const result = await resolveAttachmentImages(["gen_abc"], SCOPE);

    expect(result.size).toBe(1);
    const resolved = result.get("gen_abc");
    expect(resolved?.mediaType).toBe("image/png");
    expect(resolved?.data).toBeInstanceOf(Buffer);
    expect(Array.from(resolved!.data)).toEqual([1, 2, 3, 4]);
    expect(mockStorageGet).toHaveBeenCalledWith("generated/images/org-1/uuid.png");
  });

  it("omits an id the DB query didn't return (unknown/foreign/wrong-kind/not-ready) — caller decides how to react", async () => {
    dbState.rows = [
      { publicId: "gen_known", storageKey: "key1", mimeType: "image/png" },
      // "gen_unknown" is requested below but absent from the DB result.
    ];

    const result = await resolveAttachmentImages(["gen_known", "gen_unknown"], SCOPE);

    expect(result.has("gen_known")).toBe(true);
    expect(result.has("gen_unknown")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("resolves multiple attachments concurrently", async () => {
    dbState.rows = [
      { publicId: "gen_1", storageKey: "key1", mimeType: "image/png" },
      { publicId: "gen_2", storageKey: "key2", mimeType: "image/jpeg" },
    ];

    const result = await resolveAttachmentImages(["gen_1", "gen_2"], SCOPE);

    expect(result.size).toBe(2);
    expect(result.get("gen_1")?.mediaType).toBe("image/png");
    expect(result.get("gen_2")?.mediaType).toBe("image/jpeg");
  });

  it("scopes the query within the caller's tenant scope", async () => {
    dbState.rows = [];
    await resolveAttachmentImages(["gen_x"], SCOPE);
    expect(mockRunInTenantScope).toHaveBeenCalledWith(SCOPE, expect.any(Function));
  });
});
