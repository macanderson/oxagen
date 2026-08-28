import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Vercel SDK so the driver is exercised without network/credentials.
const putMock = vi.fn();
const delMock = vi.fn();
const getMock = vi.fn();
vi.mock("@vercel/blob", () => ({
  put: (...args: unknown[]): unknown => putMock(...args) as unknown,
  del: (...args: unknown[]): unknown => delMock(...args) as unknown,
  get: (...args: unknown[]): unknown => getMock(...args) as unknown,
}));

import {
  createVercelBlobAdapter,
  publicBaseUrlFromToken,
  StorageNotFoundError,
} from "./vercel-blob";

describe("createVercelBlobAdapter", () => {
  beforeEach(() => {
    putMock.mockReset();
    delMock.mockReset();
    getMock.mockReset();
  });

  it("reports the driver name", () => {
    const adapter = createVercelBlobAdapter("tok");
    expect(adapter.driver).toBe("vercel-blob");
  });

  // ── put() — public (default) ──────────────────────────────────────────────

  it("puts a public object: url, canonical key, byte length, access='public'", async () => {
    putMock.mockResolvedValue({
      url: "https://store.public.blob.vercel-storage.com/avatars/u/x.webp",
      pathname: "avatars/u/x.webp",
    });
    const adapter = createVercelBlobAdapter("tok-123");
    const body = new Uint8Array([1, 2, 3, 4, 5]);

    const result = await adapter.put({
      key: "avatars/u/x.webp",
      body,
      contentType: "image/webp",
    });

    // access defaults to "public" when omitted
    expect(result).toEqual({
      url: "https://store.public.blob.vercel-storage.com/avatars/u/x.webp",
      key: "avatars/u/x.webp",
      bytes: 5,
      access: "public",
    });
    expect(putMock).toHaveBeenCalledWith(
      "avatars/u/x.webp",
      Buffer.from(body),
      {
        access: "public",
        token: "tok-123",
        contentType: "image/webp",
        addRandomSuffix: false,
        allowOverwrite: true,
      },
    );
  });

  // ── put() — private ───────────────────────────────────────────────────────

  it("puts a private object: passes access:private to SDK and returns access='private'", async () => {
    putMock.mockResolvedValue({
      url: "https://private.blob.vercel-storage.com/generated/images/org/abc.png?token=xxx",
      pathname: "generated/images/org/abc.png",
    });
    const adapter = createVercelBlobAdapter("tok-private");
    const body = new Uint8Array([10, 20, 30]);

    const result = await adapter.put({
      key: "generated/images/org/abc.png",
      body,
      contentType: "image/png",
      access: "private",
    });

    expect(result.access).toBe("private");
    expect(result.key).toBe("generated/images/org/abc.png");
    expect(result.bytes).toBe(3);
    expect(putMock).toHaveBeenCalledWith(
      "generated/images/org/abc.png",
      Buffer.from(body),
      {
        access: "private",
        token: "tok-private",
        contentType: "image/png",
        addRandomSuffix: false,
        allowOverwrite: true,
      },
    );
  });

  it("reports access='public' when a private put falls back on a public-only store", async () => {
    // First call (private) rejects as on a public-only store; retry (public) succeeds.
    putMock
      .mockRejectedValueOnce(
        new Error("Cannot use private access on this store"),
      )
      .mockResolvedValueOnce({
        url: "https://store.public.blob.vercel-storage.com/generated/images/org/abc.png",
        pathname: "generated/images/org/abc.png",
      });
    const adapter = createVercelBlobAdapter("tok-public-only");
    const body = new Uint8Array([1, 2, 3, 4]);

    const result = await adapter.put({
      key: "generated/images/org/abc.png",
      body,
      contentType: "image/png",
      access: "private",
    });

    // The blob was physically stored as public — the result MUST reflect that
    // so callers never treat a world-readable blob as access-controlled.
    expect(result.access).toBe("public");
    expect(result.key).toBe("generated/images/org/abc.png");
    expect(putMock).toHaveBeenCalledTimes(2);
    expect(putMock).toHaveBeenLastCalledWith(
      "generated/images/org/abc.png",
      Buffer.from(body),
      {
        access: "public",
        token: "tok-public-only",
        contentType: "image/png",
        addRandomSuffix: false,
        allowOverwrite: true,
      },
    );
  });

  it("computes bytes from a Blob body", async () => {
    putMock.mockResolvedValue({ url: "https://blob.example/k", pathname: "k" });
    const adapter = createVercelBlobAdapter("tok");
    const blob = new Blob([new Uint8Array(10)], { type: "image/webp" });

    const result = await adapter.put({
      key: "k",
      body: blob,
      contentType: "image/webp",
    });

    expect(result.bytes).toBe(10);
  });

  // ── delete() ──────────────────────────────────────────────────────────────

  it("delegates delete to the SDK with the token", async () => {
    delMock.mockResolvedValue(undefined);
    const adapter = createVercelBlobAdapter("tok-9");

    await adapter.delete("https://blob.example/avatars/u/x.webp");

    expect(delMock).toHaveBeenCalledWith(
      "https://blob.example/avatars/u/x.webp",
      { token: "tok-9" },
    );
  });

  // ── get() ─────────────────────────────────────────────────────────────────
  // get() uses the authenticated @vercel/blob get() SDK path so it works for
  // both public and private blobs without constructing a public CDN URL.

  it("get: uses authenticated SDK, streams body, returns content-type + size", async () => {
    const STREAM = new ReadableStream<Uint8Array>();
    getMock.mockResolvedValue({
      stream: STREAM,
      headers: new Headers(),
      blob: {
        contentType: "image/png",
        size: 3,
        pathname: "uploads/fil_XYZ/file.png",
        url: "",
        downloadUrl: "",
        uploadedAt: new Date(),
      },
    });

    const adapter = createVercelBlobAdapter(
      "vercel_blob_rw_abc123_supersecret",
    );
    const result = await adapter.get("uploads/fil_XYZ/file.png");

    // SDK get() called with the token and access:"private" (authenticated path)
    expect(getMock).toHaveBeenCalledWith("uploads/fil_XYZ/file.png", {
      token: "vercel_blob_rw_abc123_supersecret",
      access: "private",
    });
    expect(result.contentType).toBe("image/png");
    expect(result.sizeBytes).toBe(3);
    expect(result.body).toBe(STREAM);
  });

  it("get: works for private blobs (authenticated path, no public CDN fetch)", async () => {
    const STREAM = new ReadableStream<Uint8Array>();
    getMock.mockResolvedValue({
      stream: STREAM,
      headers: new Headers(),
      blob: {
        contentType: "video/mp4",
        size: 9000,
        pathname: "generated/videos/org/asset.mp4",
        url: "",
        downloadUrl: "",
        uploadedAt: new Date(),
      },
    });

    const adapter = createVercelBlobAdapter("vercel_blob_rw_store99_secret");
    const result = await adapter.get("generated/videos/org/asset.mp4");

    expect(getMock).toHaveBeenCalledWith("generated/videos/org/asset.mp4", {
      token: "vercel_blob_rw_store99_secret",
      access: "private",
    });
    expect(result.contentType).toBe("video/mp4");
    expect(result.sizeBytes).toBe(9000);
    expect(result.body).toBe(STREAM);
  });

  it("get: zero/null size in blob metadata yields null sizeBytes", async () => {
    const STREAM = new ReadableStream<Uint8Array>();
    getMock.mockResolvedValue({
      stream: STREAM,
      headers: new Headers(),
      blob: {
        contentType: "application/octet-stream",
        size: 0,
        pathname: "some/key.bin",
        url: "",
        downloadUrl: "",
        uploadedAt: new Date(),
      },
    });

    const adapter = createVercelBlobAdapter("vercel_blob_rw_store42_secret");
    const result = await adapter.get("some/key.bin");

    expect(result.sizeBytes).toBeNull();
  });

  it("get: throws StorageNotFoundError when SDK returns null (blob not found / 404)", async () => {
    getMock.mockResolvedValue(null);

    const adapter = createVercelBlobAdapter("vercel_blob_rw_store42_secret");

    await expect(adapter.get("missing/key.bin")).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  it("get: throws StorageNotFoundError when stream is null (304 not modified case)", async () => {
    getMock.mockResolvedValue({
      stream: null,
      headers: new Headers(),
      blob: {
        contentType: "image/png",
        size: 100,
        pathname: "some/key.png",
        url: "",
        downloadUrl: "",
        uploadedAt: new Date(),
      },
    });

    const adapter = createVercelBlobAdapter("vercel_blob_rw_store42_secret");

    await expect(adapter.get("some/key.png")).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
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
