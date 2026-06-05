import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Vercel SDK so the driver is exercised without network/credentials.
const putMock = vi.fn();
const delMock = vi.fn();
vi.mock("@vercel/blob", () => ({
  put: (...args: unknown[]): unknown => putMock(...args) as unknown,
  del: (...args: unknown[]): unknown => delMock(...args) as unknown,
}));

import { createVercelBlobAdapter, publicBaseUrlFromToken, StorageNotFoundError } from "./vercel-blob";

describe("createVercelBlobAdapter", () => {
  beforeEach(() => {
    putMock.mockReset();
    delMock.mockReset();
  });

  it("reports the driver name", () => {
    const adapter = createVercelBlobAdapter("tok");
    expect(adapter.driver).toBe("vercel-blob");
  });

  it("puts an object and returns url, canonical key, and byte length", async () => {
    putMock.mockResolvedValue({ url: "https://blob.example/avatars/u/x.webp", pathname: "avatars/u/x.webp" });
    const adapter = createVercelBlobAdapter("tok-123");
    const body = new Uint8Array([1, 2, 3, 4, 5]);

    const result = await adapter.put({ key: "avatars/u/x.webp", body, contentType: "image/webp" });

    expect(result).toEqual({ url: "https://blob.example/avatars/u/x.webp", key: "avatars/u/x.webp", bytes: 5 });
    // Token is passed explicitly; suffix disabled so the caller's key is preserved.
    // Raw bytes are coerced to a Node Buffer for the SDK's PutBody type.
    expect(putMock).toHaveBeenCalledWith("avatars/u/x.webp", Buffer.from(body), {
      access: "public",
      token: "tok-123",
      contentType: "image/webp",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  });

  it("computes bytes from a Blob body", async () => {
    putMock.mockResolvedValue({ url: "https://blob.example/k", pathname: "k" });
    const adapter = createVercelBlobAdapter("tok");
    const blob = new Blob([new Uint8Array(10)], { type: "image/webp" });

    const result = await adapter.put({ key: "k", body: blob, contentType: "image/webp" });

    expect(result.bytes).toBe(10);
  });

  it("delegates delete to the SDK with the token", async () => {
    delMock.mockResolvedValue(undefined);
    const adapter = createVercelBlobAdapter("tok-9");

    await adapter.delete("https://blob.example/avatars/u/x.webp");

    expect(delMock).toHaveBeenCalledWith("https://blob.example/avatars/u/x.webp", { token: "tok-9" });
  });

  // ── get() ────────────────────────────────────────────────────────────────────

  it("get: streams the object body and returns content-type + size from response headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([10, 20, 30]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "3",
        },
      }),
    );

    const adapter = createVercelBlobAdapter("vercel_blob_rw_abc123_supersecret");
    const result = await adapter.get("uploads/fil_XYZ/file.png");

    // The URL is constructed from the storeId (abc123) + the key
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://abc123.public.blob.vercel-storage.com/uploads/fil_XYZ/file.png",
    );
    expect(result.contentType).toBe("image/png");
    expect(result.sizeBytes).toBe(3);
    expect(result.body).toBeInstanceOf(ReadableStream);

    fetchSpy.mockRestore();
  });

  it("get: null content-length in response yields null sizeBytes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        // no content-length header
      }),
    );

    const adapter = createVercelBlobAdapter("vercel_blob_rw_store99_secret");
    const result = await adapter.get("some/key.bin");

    expect(result.sizeBytes).toBeNull();
    fetchSpy.mockRestore();
  });

  it("get: throws StorageNotFoundError when backend returns 404", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );

    const adapter = createVercelBlobAdapter("vercel_blob_rw_store42_secret");

    await expect(adapter.get("missing/key.bin")).rejects.toBeInstanceOf(StorageNotFoundError);
    fetchSpy.mockRestore();
  });
});

// ── publicBaseUrlFromToken ────────────────────────────────────────────────────

describe("publicBaseUrlFromToken", () => {
  it("derives the correct base URL from a well-formed token", () => {
    const token = "vercel_blob_rw_abc123xyz_mysupersecret";
    expect(publicBaseUrlFromToken(token)).toBe(
      "https://abc123xyz.public.blob.vercel-storage.com",
    );
  });

  it("derives the correct base URL for a different store ID", () => {
    const token = "vercel_blob_rw_storeABC_randomsecretpart";
    expect(publicBaseUrlFromToken(token)).toBe(
      "https://storeABC.public.blob.vercel-storage.com",
    );
  });

  it("throws a clear error when the token is empty", () => {
    expect(() => publicBaseUrlFromToken("")).toThrow(
      "BLOB_READ_WRITE_TOKEN is missing",
    );
  });

  it("throws a clear error when the token prefix is malformed (too few segments)", () => {
    expect(() => publicBaseUrlFromToken("vercel_blob")).toThrow(
      "unexpected format",
    );
  });

  it("throws a clear error when the token does not start with 'vercel_blob_rw'", () => {
    expect(() => publicBaseUrlFromToken("aws_s3_rw_storeid_secret")).toThrow(
      "unexpected format",
    );
  });
});
