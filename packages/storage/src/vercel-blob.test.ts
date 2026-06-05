import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Vercel SDK so the driver is exercised without network/credentials.
const putMock = vi.fn();
const delMock = vi.fn();
vi.mock("@vercel/blob", () => ({
  put: (...args: unknown[]): unknown => putMock(...args) as unknown,
  del: (...args: unknown[]): unknown => delMock(...args) as unknown,
}));

import { createVercelBlobAdapter } from "./vercel-blob";

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
});
