/**
 * archive.create handler tests.
 *
 * Strategy: mock persistGeneratedAsset, @oxagen/storage, @oxagen/database,
 * and fflate so no real IO occurs. Assert:
 *   - fflate zipSync is called with the correct file map
 *   - ZIP magic header (PK\x03\x04) is present in bytes sent to persist
 *   - persistGeneratedAsset called with kind=archive, mimeType=application/zip
 *   - output shape matches contract
 *   - render directive carries file-attachment with .zip filename
 *   - text entries and base64 entries are encoded correctly
 *   - assetId entries are fetched via DB + storage and their bytes appear in ZIP
 *   - empty entries array throws a Zod validation error
 *   - unknown assetId throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ZIP magic header: PK\x03\x04
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

const FAKE_ASSET = {
  id: "asset-uuid-archive",
  publicId: "gen_ZIPTEST",
  kind: "archive" as const,
  mimeType: "application/zip",
  sizeBytes: 512,
  url: "https://blob.example.com/archive.zip",
  serveUrl: "/api/v1/assets/gen_ZIPTEST",
};

const mocks = vi.hoisted(() => ({
  persistGeneratedAsset: vi.fn(),
  zipSync: vi.fn(),
  storageGet: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mocks.persistGeneratedAsset,
}));

// Mock fflate's dynamic import.
vi.mock("fflate", () => ({
  zipSync: mocks.zipSync,
}));

// The handler does `await import("fflate")` and uses the named export zipSync.
// vi.mock intercepts both static and dynamic imports.

vi.mock("@oxagen/storage", () => ({
  storage: () => ({ get: mocks.storageGet }),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
  withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => fn({ select: mocks.dbSelect }),

  };
});

import { archiveCreateHandler } from "./archive.create";
import type { CapabilityContext } from "@oxagen/oxagen";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

// Fake ZIP output: real ZIP magic header + padding.
const FAKE_ZIP = new Uint8Array([...ZIP_MAGIC, ...new Uint8Array(100)]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.zipSync.mockReturnValue(FAKE_ZIP);
  mocks.persistGeneratedAsset.mockResolvedValue(FAKE_ASSET);
});

// ── Helper to create a fake ReadableStream from bytes ─────────────────────────
function makeReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("archiveCreateHandler — text entries", () => {
  it("encodes a text entry to UTF-8 bytes and passes it to zipSync", async () => {
    await archiveCreateHandler(
      {
        archiveName: "my-archive",
        entries: [{ name: "readme.txt", text: "Hello, world!" }],
      },
      CTX,
    );

    expect(mocks.zipSync).toHaveBeenCalledTimes(1);
    const zipArg = mocks.zipSync.mock.calls[0]?.[0] as Record<string, Uint8Array>;
    expect("readme.txt" in zipArg).toBe(true);
    const encoded = zipArg["readme.txt"] as Uint8Array;
    expect(new TextDecoder().decode(encoded)).toBe("Hello, world!");
  });

  it("multiple text entries all appear in the zip input", async () => {
    await archiveCreateHandler(
      {
        archiveName: "multi",
        entries: [
          { name: "a.txt", text: "Alpha" },
          { name: "b.txt", text: "Beta" },
          { name: "c.txt", text: "Gamma" },
        ],
      },
      CTX,
    );

    const zipArg = mocks.zipSync.mock.calls[0]?.[0] as Record<string, Uint8Array>;
    expect(Object.keys(zipArg)).toHaveLength(3);
    expect(new TextDecoder().decode(zipArg["a.txt"])).toBe("Alpha");
    expect(new TextDecoder().decode(zipArg["b.txt"])).toBe("Beta");
    expect(new TextDecoder().decode(zipArg["c.txt"])).toBe("Gamma");
  });
});

describe("archiveCreateHandler — base64 entries", () => {
  it("decodes base64 bytes and passes them to zipSync", async () => {
    const originalBytes = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const b64 = btoa(String.fromCharCode(...originalBytes));

    await archiveCreateHandler(
      {
        archiveName: "binarch",
        entries: [{ name: "data.bin", contentBase64: b64 }],
      },
      CTX,
    );

    const zipArg = mocks.zipSync.mock.calls[0]?.[0] as Record<string, Uint8Array>;
    expect("data.bin" in zipArg).toBe(true);
    const decoded = zipArg["data.bin"] as Uint8Array;
    expect(Array.from(decoded)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });
});

describe("archiveCreateHandler — assetId entries", () => {
  it("fetches asset from DB + storage and includes bytes in ZIP", async () => {
    // Fake DB query chain: select().from().where().limit()
    const assetBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const fakeStream = makeReadableStream(assetBytes);

    mocks.storageGet.mockResolvedValue({ body: fakeStream });

    // Stub the batched DB chain — select().from().where() resolves the rows
    // (no per-entry .limit() anymore). publicId keys the in-memory asset map.
    const where = vi.fn().mockResolvedValue([
      {
        publicId: "gen_SOMEEXISTING",
        storageKey: "generated/documents/org_1/abc.docx",
        orgId: "org_1",
        status: "ready",
        deletedAt: null,
      },
    ]);
    const from = vi.fn().mockReturnValue({ where });
    mocks.dbSelect.mockReturnValue({ from });

    await archiveCreateHandler(
      {
        archiveName: "asset-arch",
        entries: [{ name: "doc.docx", assetId: "gen_SOMEEXISTING" }],
      },
      CTX,
    );

    expect(mocks.storageGet).toHaveBeenCalledWith("generated/documents/org_1/abc.docx");

    const zipArg = mocks.zipSync.mock.calls[0]?.[0] as Record<string, Uint8Array>;
    expect("doc.docx" in zipArg).toBe(true);
    expect(Array.from(zipArg["doc.docx"] as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it("throws when assetId not found in DB", async () => {
    const where = vi.fn().mockResolvedValue([]);
    const from = vi.fn().mockReturnValue({ where });
    mocks.dbSelect.mockReturnValue({ from });

    await expect(
      archiveCreateHandler(
        {
          archiveName: "fail-arch",
          entries: [{ name: "missing.pdf", assetId: "gen_MISSING" }],
        },
        CTX,
      ),
    ).rejects.toThrow("gen_MISSING");
  });

  it("throws when assetId belongs to a different org (IDOR guard)", async () => {
    const where = vi.fn().mockResolvedValue([
      {
        publicId: "gen_OTHER",
        storageKey: "generated/documents/OTHER_ORG/file.docx",
        orgId: "OTHER_ORG", // different from ctx.orgId
        status: "ready",
        deletedAt: null,
      },
    ]);
    const from = vi.fn().mockReturnValue({ where });
    mocks.dbSelect.mockReturnValue({ from });

    await expect(
      archiveCreateHandler(
        {
          archiveName: "idor-arch",
          entries: [{ name: "other.docx", assetId: "gen_OTHER" }],
        },
        CTX,
      ),
    ).rejects.toThrow("gen_OTHER");
  });

  it("batch-loads N asset entries with a single DB select", async () => {
    // The metadata for every referenced asset is fetched in ONE inArray query
    // (was one SELECT per entry — the N+1 this change removes). Blob bytes are
    // still fetched per entry, in parallel.
    const rows = [
      { publicId: "gen_A", storageKey: "k/a", orgId: "org_1", status: "ready", deletedAt: null },
      { publicId: "gen_B", storageKey: "k/b", orgId: "org_1", status: "ready", deletedAt: null },
      { publicId: "gen_C", storageKey: "k/c", orgId: "org_1", status: "ready", deletedAt: null },
    ];
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    mocks.dbSelect.mockReturnValue({ from });

    // Each entry's blob is read independently — hand out a fresh stream per call
    // (a ReadableStream can only be consumed once).
    mocks.storageGet.mockImplementation((key: string) =>
      Promise.resolve({
        body: makeReadableStream(new Uint8Array([key.charCodeAt(key.length - 1)])),
      }),
    );

    await archiveCreateHandler(
      {
        archiveName: "batch",
        entries: [
          { name: "a.docx", assetId: "gen_A" },
          { name: "b.docx", assetId: "gen_B" },
          { name: "c.docx", assetId: "gen_C" },
        ],
      },
      CTX,
    );

    // ONE select for all three asset entries.
    expect(mocks.dbSelect).toHaveBeenCalledTimes(1);
    // All three blobs were still fetched.
    expect(mocks.storageGet).toHaveBeenCalledTimes(3);
    const zipArg = mocks.zipSync.mock.calls[0]?.[0] as Record<string, Uint8Array>;
    expect(Object.keys(zipArg).sort()).toEqual(["a.docx", "b.docx", "c.docx"]);
  });
});

describe("archiveCreateHandler — output", () => {
  it("persists with kind=archive and mimeType=application/zip", async () => {
    await archiveCreateHandler(
      {
        archiveName: "output-test",
        entries: [{ name: "file.txt", text: "content" }],
      },
      CTX,
    );

    const persistArg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(persistArg.kind).toBe("archive");
    expect(persistArg.mimeType).toBe("application/zip");
  });

  it("passes ZIP magic bytes to persistGeneratedAsset", async () => {
    await archiveCreateHandler(
      {
        archiveName: "magic-test",
        entries: [{ name: "x.txt", text: "x" }],
      },
      CTX,
    );

    const persistArg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<string, unknown>;
    const bytes = persistArg.bytes as Uint8Array;
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
  });

  it("output shape matches contract", async () => {
    const result = await archiveCreateHandler(
      {
        archiveName: "shape-test",
        entries: [{ name: "x.txt", text: "x" }],
      },
      CTX,
    );

    expect(result.assetId).toBe(FAKE_ASSET.id);
    expect(result.publicId).toBe(FAKE_ASSET.publicId);
    expect(result.kind).toBe("archive");
    expect(result.mimeType).toBe("application/zip");
    expect(result.sizeBytes).toBe(FAKE_ASSET.sizeBytes);
    expect(result.url).toBe(FAKE_ASSET.url);
    expect(result.serveUrl).toBe(FAKE_ASSET.serveUrl);
  });

  it("render directive is file-attachment with .zip filename", async () => {
    const result = await archiveCreateHandler(
      {
        archiveName: "download-me",
        entries: [{ name: "x.txt", text: "x" }],
      },
      CTX,
    );

    expect(result.render.componentId).toBe("file-attachment");
    expect(result.render.props.kind).toBe("archive");
    expect(result.render.props.name).toBe("download-me.zip");
    expect(result.render.props.mimeType).toBe("application/zip");
    expect(result.render.props.url).toBe(FAKE_ASSET.serveUrl);
  });

  it("throws when persistGeneratedAsset rejects", async () => {
    mocks.persistGeneratedAsset.mockRejectedValueOnce(new Error("storage down"));
    await expect(
      archiveCreateHandler(
        {
          archiveName: "fail",
          entries: [{ name: "x.txt", text: "x" }],
        },
        CTX,
      ),
    ).rejects.toThrow("storage down");
  });
});

describe("archiveCreateHandler — validation", () => {
  it("an entry with no source throws a clear error", async () => {
    // The contract requires at least one of assetId/contentBase64/text.
    // The handler validates this at runtime and throws.
    await expect(
      archiveCreateHandler(
        {
          archiveName: "empty-entry",
          entries: [{ name: "mystery.bin" }], // no source
        },
        CTX,
      ),
    ).rejects.toThrow("mystery.bin");
  });
});
