import { describe, it, expect, vi } from "vitest";

import { ingestImageFromUrl, isIngestibleImageUrl } from "./ingest";
import { ASSET_LIMITS } from "./assets";
import type { PutObjectInput, PutObjectResult } from "./types";

// ── isIngestibleImageUrl ────────────────────────────────────────────────────────

describe("isIngestibleImageUrl", () => {
  it("accepts https Google and GitHub avatar hosts", () => {
    expect(
      isIngestibleImageUrl("https://lh3.googleusercontent.com/a/abc"),
    ).toBe(true);
    expect(
      isIngestibleImageUrl("https://avatars.githubusercontent.com/u/1?v=4"),
    ).toBe(true);
  });
  it("rejects non-https, untrusted hosts, and garbage", () => {
    expect(isIngestibleImageUrl("http://lh3.googleusercontent.com/a")).toBe(
      false,
    );
    expect(isIngestibleImageUrl("https://evil.example.com/x.png")).toBe(false);
    expect(
      isIngestibleImageUrl("https://googleusercontent.com.evil.com/x"),
    ).toBe(false);
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
      {
        url: "https://avatars.githubusercontent.com/u/1?v=4",
        kind: "avatar",
        ownerId: "u",
      },
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
      {
        url: "https://169.254.169.254/latest/meta-data",
        kind: "avatar",
        ownerId: "u",
      },
      { fetchImpl, putImpl },
    );

    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(putImpl).not.toHaveBeenCalled();
  });

  it("returns null on a non-image content type", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("<html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const putImpl = vi.fn(async () => OK_PUT);
    const result = await ingestImageFromUrl(
      {
        url: "https://lh3.googleusercontent.com/a/x",
        kind: "avatar",
        ownerId: "u",
      },
      { fetchImpl, putImpl },
    );
    expect(result).toBeNull();
    expect(putImpl).not.toHaveBeenCalled();
  });

  // Regression: a bare `ASSET_ALLOWED_TYPES[kind][contentType]` index resolves
  // inherited Object.prototype keys to truthy values, so a remote host serving
  // `Content-Type: constructor` would bypass the MIME allowlist entirely.
  it("returns null when the remote content type is an Object.prototype key", async () => {
    const putImpl = vi.fn(async () => OK_PUT);
    for (const mime of ["constructor", "__proto__", "toString"]) {
      const result = await ingestImageFromUrl(
        {
          url: "https://lh3.googleusercontent.com/a/x",
          kind: "avatar",
          ownerId: "u",
        },
        {
          fetchImpl: vi.fn(
            async () =>
              new Response(new Uint8Array(10), {
                status: 200,
                headers: { "content-type": mime },
              }),
          ),
          putImpl,
        },
      );
      expect(result).toBeNull();
    }
    expect(putImpl).not.toHaveBeenCalled();
  });

  it("returns null on an oversize or empty body", async () => {
    const putImpl = vi.fn(async () => OK_PUT);
    const oversize = await ingestImageFromUrl(
      {
        url: "https://lh3.googleusercontent.com/a/x",
        kind: "avatar",
        ownerId: "u",
      },
      {
        fetchImpl: vi.fn(async () => jpegResponse(ASSET_LIMITS.avatar + 1)),
        putImpl,
      },
    );
    const empty = await ingestImageFromUrl(
      {
        url: "https://lh3.googleusercontent.com/a/x",
        kind: "avatar",
        ownerId: "u",
      },
      { fetchImpl: vi.fn(async () => jpegResponse(0)), putImpl },
    );
    expect(oversize).toBeNull();
    expect(empty).toBeNull();
    expect(putImpl).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when fetch or storage fails", async () => {
    const fetchThrows = await ingestImageFromUrl(
      {
        url: "https://lh3.googleusercontent.com/a/x",
        kind: "avatar",
        ownerId: "u",
      },
      {
        fetchImpl: vi.fn(async () => {
          throw new Error("network down");
        }),
      },
    );
    const putThrows = await ingestImageFromUrl(
      {
        url: "https://lh3.googleusercontent.com/a/x",
        kind: "avatar",
        ownerId: "u",
      },
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
      {
        url: "https://lh3.googleusercontent.com/a/x",
        kind: "avatar",
        ownerId: "u",
      },
      { fetchImpl: vi.fn(async () => new Response("nope", { status: 404 })) },
    );
    expect(result).toBeNull();
  });

  it("uses manual redirect handling (does not blindly follow)", async () => {
    const fetchImpl = vi.fn(async () => jpegResponse(10));
    const putImpl = vi.fn(async () => OK_PUT);
    await ingestImageFromUrl(
      {
        url: "https://lh3.googleusercontent.com/a/x",
        kind: "avatar",
        ownerId: "u",
      },
      { fetchImpl, putImpl },
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://lh3.googleusercontent.com/a/x",
      {
        redirect: "manual",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("SSRF: refuses to follow a redirect to an untrusted/internal host", async () => {
    // Trusted host issues an open redirect to the cloud metadata endpoint.
    const fetchImpl = vi.fn(async (target: string | URL | Request) => {
      if (String(target).startsWith("https://lh3.googleusercontent.com")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      }
      // Should never be reached — the metadata host is not on the allowlist.
      return jpegResponse(10);
    });
    const putImpl = vi.fn(async () => OK_PUT);

    const result = await ingestImageFromUrl(
      {
        url: "https://lh3.googleusercontent.com/a/x",
        kind: "avatar",
        ownerId: "u",
      },
      { fetchImpl, putImpl },
    );

    expect(result).toBeNull();
    // The redirect target was never fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(putImpl).not.toHaveBeenCalled();
  });

  it("follows a redirect to another trusted host and stores the bytes", async () => {
    const fetchImpl = vi.fn(async (target: string | URL | Request) => {
      if (String(target) === "https://lh3.googleusercontent.com/a/x") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://avatars.githubusercontent.com/u/1" },
        });
      }
      return jpegResponse(10);
    });
    const putImpl = vi.fn(async () => OK_PUT);

    const result = await ingestImageFromUrl(
      {
        url: "https://lh3.googleusercontent.com/a/x",
        kind: "avatar",
        ownerId: "u",
      },
      { fetchImpl, putImpl },
    );

    expect(result).toEqual(OK_PUT);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(putImpl).toHaveBeenCalledOnce();
  });

  it("returns null when the redirect chain exceeds the hop cap", async () => {
    // Trusted host that keeps redirecting to itself forever.
    const fetchImpl = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: "https://lh3.googleusercontent.com/a/loop" },
      });
    });
    const putImpl = vi.fn(async () => OK_PUT);

    const result = await ingestImageFromUrl(
      {
        url: "https://lh3.googleusercontent.com/a/start",
        kind: "avatar",
        ownerId: "u",
      },
      { fetchImpl, putImpl },
    );

    expect(result).toBeNull();
    expect(putImpl).not.toHaveBeenCalled();
  });
});

describe("avatar download bounds", () => {
  const input = { url: "https://lh3.googleusercontent.com/a/x", kind: "avatar" as const, ownerId: "owner" };

  it("counts streamed bytes when the content length understates the body", async () => {
    const cancel = vi.fn();
    let produced = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { produced += 1; controller.enqueue(chunk); },
      cancel,
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: {
      "content-type": "image/jpeg", "content-length": "1",
    } });
    const putImpl = vi.fn(async () => OK_PUT);
    expect(await ingestImageFromUrl(input, { fetchImpl: vi.fn(async () => response), putImpl })).toBeNull();
    expect(produced).toBe(6);
    expect(cancel).toHaveBeenCalledOnce();
    expect(putImpl).not.toHaveBeenCalled();
  });

  it("cancels a declared oversized body before reading any bytes", async () => {
    const pull = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const response = new Response(body, { headers: {
      "content-type": "image/jpeg", "content-length": String(ASSET_LIMITS.avatar + 1),
    } });
    expect(await ingestImageFromUrl(input, { fetchImpl: vi.fn(async () => response) })).toBeNull();
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels discarded redirect and invalid content bodies", async () => {
    const cancelRedirect = vi.fn();
    const cancelContent = vi.fn();
    const redirect = new Response(new ReadableStream({ cancel: cancelRedirect }), {
      status: 302, headers: { location: "/next" },
    });
    const invalid = new Response(new ReadableStream({ cancel: cancelContent }), {
      headers: { "content-type": "text/html" },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect).mockResolvedValueOnce(invalid);
    expect(await ingestImageFromUrl(input, { fetchImpl })).toBeNull();
    expect(cancelRedirect).toHaveBeenCalledOnce();
    expect(cancelContent).toHaveBeenCalledOnce();
  });

  it("aborts a request that never returns headers after ten seconds", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn<typeof fetch>((_target, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
      const result = ingestImageFromUrl(input, { fetchImpl });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBeNull();
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the same ten second deadline for redirects and a stalled body", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const fetchImpl = vi.fn<typeof fetch>()
        .mockImplementationOnce(() => new Promise((resolve) => {
          setTimeout(() => resolve(new Response(null, {
            status: 302, headers: { location: "/next" },
          })), 6_000);
        }))
        .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
          headers: { "content-type": "image/jpeg" },
        }));
      const putImpl = vi.fn(async () => OK_PUT);
      const result = ingestImageFromUrl(input, { fetchImpl, putImpl });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(fetchImpl.mock.calls[1]?.[1]?.signal);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(await result).toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
      expect(putImpl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
