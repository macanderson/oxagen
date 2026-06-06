import { describe, it, expect, vi } from "vitest";

import { ingestImageFromUrl, isIngestibleImageUrl } from "./ingest";
import { ASSET_LIMITS } from "./assets";
import type { PutObjectInput, PutObjectResult } from "./types";

// ── isIngestibleImageUrl ────────────────────────────────────────────────────────

describe("isIngestibleImageUrl", () => {
  it("accepts https Google and GitHub avatar hosts", () => {
    expect(isIngestibleImageUrl("https://lh3.googleusercontent.com/a/abc")).toBe(true);
    expect(isIngestibleImageUrl("https://avatars.githubusercontent.com/u/1?v=4")).toBe(true);
  });
  it("rejects non-https, untrusted hosts, and garbage", () => {
    expect(isIngestibleImageUrl("http://lh3.googleusercontent.com/a")).toBe(false);
    expect(isIngestibleImageUrl("https://evil.example.com/x.png")).toBe(false);
    expect(isIngestibleImageUrl("https://googleusercontent.com.evil.com/x")).toBe(false);
    expect(isIngestibleImageUrl("not a url")).toBe(false);
    expect(isIngestibleImageUrl("")).toBe(false);
    expect(isIngestibleImageUrl(null)).toBe(false);
  });
});

// ── ingestImageFromUrl ──────────────────────────────────────────────────────────

function jpegResponse(bytes: number): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  });
}

const OK_PUT: PutObjectResult = {
  url: "https://store.public.blob.vercel-storage.com/avatar/u/x.jpg",
  key: "avatar/u/x.jpg",
  bytes: 10,
  access: "public",
};

describe("ingestImageFromUrl", () => {
  it("fetches a trusted avatar and stores it, returning the put result", async () => {
    const fetchImpl = vi.fn(async () => jpegResponse(10));
    const putImpl = vi.fn(async (_i: PutObjectInput) => OK_PUT);

    const result = await ingestImageFromUrl(
      { url: "https://avatars.githubusercontent.com/u/1?v=4", kind: "avatar", ownerId: "u" },
      { fetchImpl, putImpl },
    );

    expect(result).toEqual(OK_PUT);
    expect(fetchImpl).toHaveBeenCalledOnce();
    // Key is server-derived under the owner, ext from the content type.
    const putArg = putImpl.mock.calls[0]![0];
    expect(putArg.key).toMatch(/^avatar\/u\/[0-9a-f-]+\.jpg$/);
    expect(putArg.contentType).toBe("image/jpeg");
    expect(putArg.access).toBe("public");
  });

  it("never fetches an untrusted host (SSRF guard) and returns null", async () => {
    const fetchImpl = vi.fn(async () => jpegResponse(10));
    const putImpl = vi.fn(async () => OK_PUT);

    const result = await ingestImageFromUrl(
      { url: "https://169.254.169.254/latest/meta-data", kind: "avatar", ownerId: "u" },
      { fetchImpl, putImpl },
    );

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(putImpl).not.toHaveBeenCalled();
  });

  it("returns null on a non-image content type", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const putImpl = vi.fn(async () => OK_PUT);
    const result = await ingestImageFromUrl(
      { url: "https://lh3.googleusercontent.com/a/x", kind: "avatar", ownerId: "u" },
      { fetchImpl, putImpl },
    );
    expect(result).toBeNull();
    expect(putImpl).not.toHaveBeenCalled();
  });

  it("returns null on an oversize or empty body", async () => {
    const putImpl = vi.fn(async () => OK_PUT);
    const oversize = await ingestImageFromUrl(
      { url: "https://lh3.googleusercontent.com/a/x", kind: "avatar", ownerId: "u" },
      { fetchImpl: vi.fn(async () => jpegResponse(ASSET_LIMITS.avatar + 1)), putImpl },
    );
    const empty = await ingestImageFromUrl(
      { url: "https://lh3.googleusercontent.com/a/x", kind: "avatar", ownerId: "u" },
      { fetchImpl: vi.fn(async () => jpegResponse(0)), putImpl },
    );
    expect(oversize).toBeNull();
    expect(empty).toBeNull();
    expect(putImpl).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when fetch or storage fails", async () => {
    const fetchThrows = await ingestImageFromUrl(
      { url: "https://lh3.googleusercontent.com/a/x", kind: "avatar", ownerId: "u" },
      {
        fetchImpl: vi.fn(async () => {
          throw new Error("network down");
        }),
      },
    );
    const putThrows = await ingestImageFromUrl(
      { url: "https://lh3.googleusercontent.com/a/x", kind: "avatar", ownerId: "u" },
      {
        fetchImpl: vi.fn(async () => jpegResponse(10)),
        putImpl: vi.fn(async () => {
          throw new Error("blob token missing");
        }),
      },
    );
    expect(fetchThrows).toBeNull();
    expect(putThrows).toBeNull();
  });

  it("returns null on a non-OK HTTP status", async () => {
    const result = await ingestImageFromUrl(
      { url: "https://lh3.googleusercontent.com/a/x", kind: "avatar", ownerId: "u" },
      { fetchImpl: vi.fn(async () => new Response("nope", { status: 404 })) },
    );
    expect(result).toBeNull();
  });
});
