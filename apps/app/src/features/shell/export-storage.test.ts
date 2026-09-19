// The shell's blob seam. One read, so there is one thing to prove: the key the
// capability reported is the key the store is asked for, and the two fields the
// download route needs come back untouched. `sizeBytes` is deliberately not
// carried — a route that streams never sets Content-Length from a value the
// store may report as null.
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const storage = vi.fn(() => ({ driver: "test", get }));

vi.mock("@oxagen/storage", () => ({ storage }));

const { readExportObject } = await import("./export-storage");

const KEY = "privacy-exports/org-1/7a000000.zip";

function bodyOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

beforeEach(() => {
  get.mockReset();
  storage.mockClear();
});

describe("readExportObject", () => {
  it("streams the object at the key it was given", async () => {
    const body = bodyOf("zip-bytes");
    get.mockResolvedValue({
      body,
      contentType: "application/zip",
      sizeBytes: 9,
    });
    expect(await readExportObject(KEY)).toEqual({
      body,
      contentType: "application/zip",
    });
    expect(get).toHaveBeenCalledWith(KEY);
  });

  it("carries a store that reports no content type through as null", async () => {
    get.mockResolvedValue({
      body: bodyOf("zip-bytes"),
      contentType: null,
      sizeBytes: null,
    });
    expect((await readExportObject(KEY)).contentType).toBeNull();
  });

  // A refusal from the store is the route's 500, not a 404 this seam invents:
  // the capability already answered that the archive is there and is ready.
  it("lets a store failure reach the caller (negative)", async () => {
    get.mockRejectedValue(new Error("store unavailable"));
    await expect(readExportObject(KEY)).rejects.toThrow("store unavailable");
  });
});
