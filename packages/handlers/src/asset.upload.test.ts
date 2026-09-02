/**
 * Unit tests for the asset.upload handler.
 *
 * Covers:
 *  - SSRF guard: private/loopback/link-local IPv4 and IPv6 addresses rejected.
 *  - SSRF guard: bare hostnames "localhost" and "metadata.google.internal" rejected.
 *  - SSRF guard: non-http(s) schemes rejected.
 *  - Oversize asset rejected before storage is called.
 *  - Disallowed content-type rejected.
 *  - Auth guard: no userId AND no apiKeyId → throws Unauthorized.
 *  - Auth guard: missing orgId → throws Forbidden.
 *  - Happy path: calls storage().put with an owner-derived key; returns url/key/contentType/bytes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted stubs ─────────────────────────────────────────────────────────────

const { mockPut, mockPersistGeneratedAsset } = vi.hoisted(() => ({
  mockPut: vi.fn(),
  mockPersistGeneratedAsset: vi.fn(),
}));

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@oxagen/storage", async (importOriginal) => {
  // Import the real module so assertAllowedAssetType, deriveAssetKey,
  // ASSET_LIMITS are the genuine implementations.
  const real = await importOriginal<typeof import("@oxagen/storage")>();
  return {
    ...real,
    // Override the storage() factory to return our mock adapter.
    storage: () => ({ put: mockPut }),
  };
});

// persistGeneratedAsset has its own dedicated unit tests
// (generated-asset.persist.test.ts) covering the blob-write + DB-insert
// internals; here we only assert asset.upload calls it correctly.
vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mockPersistGeneratedAsset,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { assetUploadHandler, assertPublicHttpUrl } from "./asset.upload";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── Helpers ───────────────────────────────────────────────────────────────────

const validCtx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api",
  messageId: null,
};

function makeResponse(
  body: ArrayBuffer,
  contentType: string,
  status = 200,
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

function pngBuffer(bytes = 100): ArrayBuffer {
  return new ArrayBuffer(bytes);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ── assertPublicHttpUrl ───────────────────────────────────────────────────────

describe("assertPublicHttpUrl — SSRF protection", () => {
  it("accepts a public https URL", () => {
    expect(() =>
      assertPublicHttpUrl("https://example.com/image.png"),
    ).not.toThrow();
  });

  it("accepts a public http URL", () => {
    expect(() =>
      assertPublicHttpUrl("http://example.com/image.png"),
    ).not.toThrow();
  });

  it("rejects non-http scheme (ftp)", () => {
    expect(() => assertPublicHttpUrl("ftp://example.com/file")).toThrow(
      /non-public/i,
    );
  });

  it("rejects 'file://' scheme", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow(
      /non-public/i,
    );
  });

  it("rejects bare hostname 'localhost'", () => {
    expect(() => assertPublicHttpUrl("http://localhost/image.png")).toThrow(
      /non-public/i,
    );
  });

  it("rejects 'metadata.google.internal'", () => {
    expect(() =>
      assertPublicHttpUrl(
        "http://metadata.google.internal/computeMetadata/v1/",
      ),
    ).toThrow(/non-public/i);
  });

  it("rejects 127.0.0.1 (loopback)", () => {
    expect(() => assertPublicHttpUrl("http://127.0.0.1/")).toThrow(
      /non-public/i,
    );
  });

  it("rejects 10.0.0.1 (private class A)", () => {
    expect(() => assertPublicHttpUrl("http://10.0.0.1/image.png")).toThrow(
      /non-public/i,
    );
  });

  it("rejects 172.16.0.1 (private class B)", () => {
    expect(() => assertPublicHttpUrl("http://172.16.0.1/")).toThrow(
      /non-public/i,
    );
  });

  it("rejects 192.168.1.1 (private class C)", () => {
    expect(() => assertPublicHttpUrl("http://192.168.1.1/")).toThrow(
      /non-public/i,
    );
  });

  it("rejects 169.254.169.254 (AWS/GCP IMDS)", () => {
    expect(() =>
      assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/"),
    ).toThrow(/non-public/i);
  });

  it("rejects 0.0.0.0", () => {
    expect(() => assertPublicHttpUrl("http://0.0.0.0/")).toThrow(/non-public/i);
  });

  it("rejects ::1 (IPv6 loopback)", () => {
    expect(() => assertPublicHttpUrl("http://[::1]/")).toThrow(/non-public/i);
  });

  it("rejects fe80:: (IPv6 link-local)", () => {
    expect(() => assertPublicHttpUrl("http://[fe80::1]/")).toThrow(
      /non-public/i,
    );
  });

  it("rejects fd00:: (IPv6 unique-local)", () => {
    expect(() => assertPublicHttpUrl("http://[fd00::1]/")).toThrow(
      /non-public/i,
    );
  });
});

// ── Auth guards ───────────────────────────────────────────────────────────────

describe("assetUploadHandler — authorization guards", () => {
  it("throws Unauthorized when no principal is present", async () => {
    const ctx: CapabilityContext = {
      ...validCtx,
      userId: null,
      apiKeyId: null,
    };
    await expect(
      assetUploadHandler(
        { sourceUrl: "https://example.com/img.png", kind: "image" },
        ctx,
      ),
    ).rejects.toThrow(/Unauthorized/);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("throws Forbidden when orgId is empty", async () => {
    const ctx: CapabilityContext = { ...validCtx, orgId: "" };
    await expect(
      assetUploadHandler(
        { sourceUrl: "https://example.com/img.png", kind: "image" },
        ctx,
      ),
    ).rejects.toThrow(/Forbidden/);
    expect(mockPut).not.toHaveBeenCalled();
  });
});

// ── SSRF inside handler ───────────────────────────────────────────────────────

describe("assetUploadHandler — SSRF rejection", () => {
  it("rejects a private IPv4 URL without fetching", async () => {
    await expect(
      assetUploadHandler(
        { sourceUrl: "http://192.168.1.100/image.png", kind: "image" },
        validCtx,
      ),
    ).rejects.toThrow(/non-public/i);
    expect(mockPut).not.toHaveBeenCalled();
  });
});

// ── Oversize ──────────────────────────────────────────────────────────────────

describe("assetUploadHandler — oversize rejection", () => {
  it("rejects an asset that exceeds the kind limit", async () => {
    const oversizeBytes = 6 * 1024 * 1024; // 6 MiB — over the 5 MiB image limit
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeResponse(new ArrayBuffer(oversizeBytes), "image/png"),
      );

    await expect(
      assetUploadHandler(
        { sourceUrl: "https://example.com/big.png", kind: "image" },
        validCtx,
      ),
    ).rejects.toThrow(/exceeds/i);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(mockPut).not.toHaveBeenCalled();
  });
});

// ── Disallowed content type ───────────────────────────────────────────────────

describe("assetUploadHandler — disallowed content-type rejection", () => {
  it("rejects when the server returns an unsupported content type", async () => {
    // gif is allowed for "image" (agent screenshots/recordings are commonly
    // gif) — use svg, which isn't in any kind's allowlist, to stay genuinely
    // unsupported regardless of future allowlist changes.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeResponse(pngBuffer(), "image/svg+xml"));

    await expect(
      assetUploadHandler(
        { sourceUrl: "https://example.com/icon.svg", kind: "image" },
        validCtx,
      ),
    ).rejects.toThrow(/Unsupported/i);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(mockPut).not.toHaveBeenCalled();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("assetUploadHandler — happy path", () => {
  it("stores the asset and returns url/key/contentType/bytes", async () => {
    const storedUrl = "https://cdn.example.com/image/org-1/some-uuid.png";
    const storedKey = "image/org-1/some-uuid.png";
    mockPut.mockResolvedValueOnce({
      url: storedUrl,
      key: storedKey,
      bytes: 100,
      access: "public" as const,
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeResponse(pngBuffer(100), "image/png"));

    const result = await assetUploadHandler(
      { sourceUrl: "https://example.com/photo.png", kind: "image" },
      validCtx,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();

    // Output shape matches contract
    expect(result.url).toBe(storedUrl);
    // The key is server-derived via deriveAssetKey — assert pattern, not exact value
    expect(result.key).toMatch(/^image\/org-1\/.+\.png$/);
    expect(result.contentType).toBe("image/png");
    expect(result.bytes).toBe(100);

    // storage().put was called with an owner-derived key (not user input)
    expect(mockPut).toHaveBeenCalledOnce();
    const putArg = mockPut.mock.calls[0]![0] as {
      key: string;
      contentType: string;
      access: string;
    };
    // Key must start with "image/org-1/" — never a user-supplied value
    expect(putArg.key).toMatch(/^image\/org-1\//);
    expect(putArg.contentType).toBe("image/png");
    expect(putArg.access).toBe("public");
  });

  it("works for a document kind with PDF content type", async () => {
    const storedUrl = "https://cdn.example.com/document/org-1/some-uuid.pdf";
    const storedKey = "document/org-1/some-uuid.pdf";
    mockPut.mockResolvedValueOnce({
      url: storedUrl,
      key: storedKey,
      bytes: 2048,
      access: "public" as const,
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(new ArrayBuffer(2048), "application/pdf"),
    );

    const result = await assetUploadHandler(
      { sourceUrl: "https://example.com/report.pdf", kind: "document" },
      validCtx,
    );

    expect(result.contentType).toBe("application/pdf");
    expect(result.bytes).toBe(2048);
    const putArg = mockPut.mock.calls[0]![0] as { key: string };
    expect(putArg.key).toMatch(/^document\/org-1\//);
  });

  it("works for an API-key context (no userId)", async () => {
    mockPut.mockResolvedValueOnce({
      url: "https://cdn.example.com/image/org-1/uuid.webp",
      key: "image/org-1/uuid.webp",
      bytes: 50,
      access: "public" as const,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(pngBuffer(50), "image/webp"),
    );

    const apiKeyCtx: CapabilityContext = {
      ...validCtx,
      userId: null,
      apiKeyId: "aky_abc",
    };
    const result = await assetUploadHandler(
      { sourceUrl: "https://example.com/logo.webp", kind: "avatar" },
      apiKeyCtx,
    );

    expect(result.contentType).toBe("image/webp");
    expect(mockPut).toHaveBeenCalledOnce();
    expect(result.publicId).toBeNull();
  });

  it("returns publicId: null for the legacy path (no source given)", async () => {
    mockPut.mockResolvedValueOnce({
      url: "https://cdn.example.com/document/org-1/uuid.pdf",
      key: "document/org-1/uuid.pdf",
      bytes: 10,
      access: "public" as const,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(new ArrayBuffer(10), "application/pdf"),
    );

    const result = await assetUploadHandler(
      { sourceUrl: "https://example.com/report.pdf", kind: "document" },
      validCtx,
    );

    expect(result.publicId).toBeNull();
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });
});

// ── source: "user_upload" (conversation-attachment ingest) ──────────────────

describe("assetUploadHandler — source: user_upload guards", () => {
  it("rejects kind: avatar with source: user_upload", async () => {
    await expect(
      assetUploadHandler(
        {
          sourceUrl: "https://example.com/logo.webp",
          kind: "avatar",
          source: "user_upload",
        },
        validCtx,
      ),
    ).rejects.toThrow(/not supported for kind "avatar"/);
    expect(mockPut).not.toHaveBeenCalled();
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("rejects an API-key-only principal (no userId) with source: user_upload", async () => {
    const apiKeyCtx: CapabilityContext = {
      ...validCtx,
      userId: null,
      apiKeyId: "aky_abc",
    };
    await expect(
      assetUploadHandler(
        {
          sourceUrl: "https://example.com/photo.png",
          kind: "image",
          source: "user_upload",
        },
        apiKeyCtx,
      ),
    ).rejects.toThrow(/requires an authenticated user/);
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("rejects conversationId without source: user_upload", async () => {
    await expect(
      assetUploadHandler(
        {
          sourceUrl: "https://example.com/photo.png",
          kind: "image",
          conversationId: "conv_1",
        },
        validCtx,
      ),
    ).rejects.toThrow(/conversationId requires source/);
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("rejects a workspace-less context with source: user_upload", async () => {
    // CapabilityContext.workspaceId is typed as a non-nullable string; the
    // handler's runtime guard (`if (!ctx.workspaceId)`) is what actually
    // catches a missing scope, so exercise it via the falsy empty string
    // rather than `null` (a type violation the compiler would reject).
    const noWsCtx: CapabilityContext = { ...validCtx, workspaceId: "" };
    await expect(
      assetUploadHandler(
        {
          sourceUrl: "https://example.com/photo.png",
          kind: "image",
          source: "user_upload",
        },
        noWsCtx,
      ),
    ).rejects.toThrow(/requires a workspace scope/);
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });
});

describe("assetUploadHandler — source: user_upload happy path", () => {
  it("calls persistGeneratedAsset with org accessPolicy, empty prompt/model, and the conversation link", async () => {
    mockPersistGeneratedAsset.mockResolvedValueOnce({
      id: "asset-uuid",
      publicId: "gen_xyz",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 100,
      key: "generated/images/org-1/uuid.png",
      url: "https://private.blob.vercel-storage.com/x.png?token=x",
      serveUrl: "/api/v1/assets/gen_xyz",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(pngBuffer(100), "image/png"),
    );

    const result = await assetUploadHandler(
      {
        sourceUrl: "https://example.com/photo.png",
        kind: "image",
        source: "user_upload",
        conversationId: "conv_1",
      },
      validCtx,
    );

    expect(mockPut).not.toHaveBeenCalled();
    expect(mockPersistGeneratedAsset).toHaveBeenCalledOnce();
    const arg = mockPersistGeneratedAsset.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(arg.orgId).toBe("org-1");
    expect(arg.workspaceId).toBe("ws-1");
    expect(arg.userId).toBe("u-1");
    expect(arg.kind).toBe("image");
    expect(arg.accessPolicy).toBe("org");
    expect(arg.prompt).toBe("");
    expect(arg.model).toBe("");
    expect(arg.source).toBe("user_upload");
    expect(arg.conversationId).toBe("conv_1");

    // Returns the private serve path + the DB row's publicId — never the raw
    // private blob URL.
    expect(result.url).toBe("/api/v1/assets/gen_xyz");
    expect(result.key).toBe("generated/images/org-1/uuid.png");
    expect(result.publicId).toBe("gen_xyz");
    expect(result.bytes).toBe(100);
  });

  it("passes conversationId: null when omitted", async () => {
    mockPersistGeneratedAsset.mockResolvedValueOnce({
      id: "asset-uuid",
      publicId: "gen_xyz",
      kind: "video",
      mimeType: "video/mp4",
      sizeBytes: 50,
      key: "generated/videos/org-1/uuid.mp4",
      url: "https://private.blob.vercel-storage.com/x.mp4?token=x",
      serveUrl: "/api/v1/assets/gen_xyz",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(new ArrayBuffer(50), "video/mp4"),
    );

    await assetUploadHandler(
      {
        sourceUrl: "https://example.com/clip.mp4",
        kind: "video",
        source: "user_upload",
      },
      validCtx,
    );

    const arg = mockPersistGeneratedAsset.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(arg.conversationId).toBeNull();
  });
});
