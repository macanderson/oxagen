/**
 * Unit tests for archiveGeneratedAssets (generated-asset.archive.ts).
 *
 * The archive helper streams already-listed conversation assets into one ZIP,
 * re-fetching each entry through serveGeneratedAsset so the per-asset access
 * policy is enforced per file. These tests mock the serve layer and verify
 * the produced ZIP bytes with fflate's real unzipSync:
 *   - all entries land in the archive with their exact bytes
 *   - duplicate filenames are deduped ("report.pdf" → "report (1).pdf")
 *   - a NotFound/Forbidden asset is skipped without corrupting the archive
 *   - an unexpected serve failure errors the stream
 *   - an empty entry list still yields a valid (empty) ZIP
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { unzipSync, strToU8, strFromU8 } from "fflate";
import type { AssetServePrincipal } from "./generated-asset.serve";

const mocks = vi.hoisted(() => ({
  serve: vi.fn(),
}));

vi.mock("./generated-asset.serve", async (importOriginal) => {
  const real = await importOriginal<typeof import("./generated-asset.serve")>();
  // Keep the REAL error classes — the archive module's instanceof checks must
  // match what the test throws.
  return { ...real, serveGeneratedAsset: mocks.serve };
});

const { archiveGeneratedAssets, uniqueZipEntryName } = await import(
  "./generated-asset.archive"
);
const { GeneratedAssetNotFoundError } = await import("./generated-asset.serve");

const PRINCIPAL: AssetServePrincipal = { userId: "user-1", surface: "app" };

function bodyStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function served(bytes: Uint8Array, mimeType = "text/plain") {
  return {
    body: bodyStream(bytes),
    mimeType,
    sizeBytes: BigInt(bytes.length),
    contentDisposition: "attachment",
  };
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("uniqueZipEntryName", () => {
  it("keeps a fresh name and dedupes repeats before the extension", () => {
    const used = new Set<string>();
    expect(uniqueZipEntryName("report.pdf", used)).toBe("report.pdf");
    expect(uniqueZipEntryName("report.pdf", used)).toBe("report (1).pdf");
    expect(uniqueZipEntryName("report.pdf", used)).toBe("report (2).pdf");
  });

  it("appends the counter at the end for extensionless names", () => {
    const used = new Set<string>();
    expect(uniqueZipEntryName("README", used)).toBe("README");
    expect(uniqueZipEntryName("README", used)).toBe("README (1)");
  });
});

describe("archiveGeneratedAssets", () => {
  it("zips every entry with its exact bytes (deflate for text, store for images)", async () => {
    const textBytes = strToU8("hello conversation");
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    mocks.serve
      .mockResolvedValueOnce(served(textBytes, "text/markdown"))
      .mockResolvedValueOnce(served(pngBytes, "image/png"));

    const zipBytes = await collect(
      archiveGeneratedAssets(
        [
          { publicId: "gen_1", name: "notes.md", mimeType: "text/markdown" },
          { publicId: "gen_2", name: "chart.png", mimeType: "image/png" },
        ],
        PRINCIPAL,
      ),
    );

    const files = unzipSync(zipBytes);
    expect(Object.keys(files).sort()).toEqual(["chart.png", "notes.md"]);
    expect(strFromU8(files["notes.md"]!)).toBe("hello conversation");
    expect(Array.from(files["chart.png"]!)).toEqual(Array.from(pngBytes));

    // Each entry's bytes were fetched through the access-controlled serve path
    // with the caller's principal — the authz seam this helper must never skip.
    expect(mocks.serve).toHaveBeenCalledTimes(2);
    expect(mocks.serve).toHaveBeenCalledWith("gen_1", PRINCIPAL);
    expect(mocks.serve).toHaveBeenCalledWith("gen_2", PRINCIPAL);
  });

  it("dedupes duplicate filenames inside the archive", async () => {
    mocks.serve
      .mockResolvedValueOnce(served(strToU8("first")))
      .mockResolvedValueOnce(served(strToU8("second")));

    const zipBytes = await collect(
      archiveGeneratedAssets(
        [
          {
            publicId: "gen_1",
            name: "report.pdf",
            mimeType: "application/pdf",
          },
          {
            publicId: "gen_2",
            name: "report.pdf",
            mimeType: "application/pdf",
          },
        ],
        PRINCIPAL,
      ),
    );

    const files = unzipSync(zipBytes);
    expect(Object.keys(files).sort()).toEqual(["report (1).pdf", "report.pdf"]);
    expect(strFromU8(files["report.pdf"]!)).toBe("first");
    expect(strFromU8(files["report (1).pdf"]!)).toBe("second");
  });

  it("skips an asset deleted between listing and download; the rest still zip", async () => {
    mocks.serve
      .mockRejectedValueOnce(new GeneratedAssetNotFoundError("gen_gone"))
      .mockResolvedValueOnce(served(strToU8("survivor")));

    const zipBytes = await collect(
      archiveGeneratedAssets(
        [
          { publicId: "gen_gone", name: "gone.txt", mimeType: "text/plain" },
          { publicId: "gen_ok", name: "ok.txt", mimeType: "text/plain" },
        ],
        PRINCIPAL,
      ),
    );

    const files = unzipSync(zipBytes);
    expect(Object.keys(files)).toEqual(["ok.txt"]);
    expect(strFromU8(files["ok.txt"]!)).toBe("survivor");
  });

  it("errors the stream on an unexpected serve failure", async () => {
    mocks.serve.mockRejectedValueOnce(new Error("storage outage"));

    await expect(
      collect(
        archiveGeneratedAssets(
          [{ publicId: "gen_1", name: "a.txt", mimeType: "text/plain" }],
          PRINCIPAL,
        ),
      ),
    ).rejects.toThrow("storage outage");
  });

  it("yields a valid empty ZIP for an empty entry list", async () => {
    const zipBytes = await collect(archiveGeneratedAssets([], PRINCIPAL));
    expect(unzipSync(zipBytes)).toEqual({});
    expect(mocks.serve).not.toHaveBeenCalled();
  });
});
