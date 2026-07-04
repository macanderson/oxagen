import { describe, expect, it, vi, beforeEach } from "vitest";

const mockGetSession = vi.fn();
const mockResolveWorkspaceScope = vi.fn();
const mockPersistGeneratedAsset = vi.fn();

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveWorkspaceScope: (...args: unknown[]) => mockResolveWorkspaceScope(...args),
}));

vi.mock("@oxagen/handlers", () => ({
  persistGeneratedAsset: (...args: unknown[]) => mockPersistGeneratedAsset(...args),
}));

const SESSION = { user: { id: "user-1" } };
const SCOPE = { orgId: "org-1", workspaceId: "ws-1" };

function buildRequest(fields: Record<string, string | Blob>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, value);
  }
  return new Request("http://localhost/api/v1/upload/attachment", {
    method: "POST",
    body: form,
  });
}

function pngFile(name = "photo.png", size = 128): File {
  return new File([new Uint8Array(size)], name, { type: "image/png" });
}

describe("POST /api/v1/upload/attachment", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveWorkspaceScope.mockResolvedValue(SCOPE);
    mockPersistGeneratedAsset.mockResolvedValue({
      id: "internal-1",
      publicId: "gen_abc123",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 128,
      key: "generated/images/org-1/uuid.png",
      url: "https://blob.example/generated/images/org-1/uuid.png",
      serveUrl: "/api/v1/assets/gen_abc123",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    mockGetSession.mockResolvedValue(null);
    const { POST } = await import("./route");
    const req = buildRequest({ file: pngFile(), kind: "image", workspaceId: "ws-1" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when the file field is missing", async () => {
    const { POST } = await import("./route");
    const req = buildRequest({ kind: "image", workspaceId: "ws-1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid kind", async () => {
    const { POST } = await import("./route");
    const req = buildRequest({ file: pngFile(), kind: "avatar", workspaceId: "ws-1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when workspaceId is missing", async () => {
    const { POST } = await import("./route");
    const req = buildRequest({ file: pngFile(), kind: "image" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the caller is not a workspace member", async () => {
    mockResolveWorkspaceScope.mockResolvedValue(null);
    const { POST } = await import("./route");
    const req = buildRequest({ file: pngFile(), kind: "image", workspaceId: "ws-1" });
    const res = await POST(req);
    expect(res.status).toBe(404);
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("returns 415 for a disallowed mime type for the given kind", async () => {
    const { POST } = await import("./route");
    const badFile = new File([new Uint8Array(10)], "malware.exe", {
      type: "application/x-msdownload",
    });
    const req = buildRequest({ file: badFile, kind: "image", workspaceId: "ws-1" });
    const res = await POST(req);
    expect(res.status).toBe(415);
  });

  it("returns 400 for an empty file", async () => {
    const { POST } = await import("./route");
    const empty = new File([], "empty.png", { type: "image/png" });
    const req = buildRequest({ file: empty, kind: "image", workspaceId: "ws-1" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 413 when the file exceeds the kind's size limit", async () => {
    const { POST } = await import("./route");
    // image limit is 5 MiB — exceed it without allocating the whole buffer twice.
    const oversized = new File([new Uint8Array(6 * 1024 * 1024)], "big.png", {
      type: "image/png",
    });
    const req = buildRequest({ file: oversized, kind: "image", workspaceId: "ws-1" });
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("persists the asset and returns a conversationAssetItem-compatible body", async () => {
    const { POST } = await import("./route");
    const req = buildRequest({
      file: pngFile("cat.png"),
      kind: "image",
      workspaceId: "ws-1",
      conversationId: "cnv-1",
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      publicId: "gen_abc123",
      kind: "image",
      name: "cat.png",
      mimeType: "image/png",
      url: "/api/v1/assets/gen_abc123",
      sizeBytes: 128,
    });
    expect(mockPersistGeneratedAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        workspaceId: "ws-1",
        userId: "user-1",
        kind: "image",
        source: "user_upload",
        accessPolicy: "org",
        mimeType: "image/png",
        conversationId: "cnv-1",
      }),
    );
  });

  it("passes conversationId as null when omitted", async () => {
    const { POST } = await import("./route");
    const req = buildRequest({ file: pngFile(), kind: "image", workspaceId: "ws-1" });
    await POST(req);
    expect(mockPersistGeneratedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: null }),
    );
  });

  it("maps a BLOB_READ_WRITE_TOKEN failure to 503", async () => {
    mockPersistGeneratedAsset.mockRejectedValue(
      new Error("Missing BLOB_READ_WRITE_TOKEN"),
    );
    const { POST } = await import("./route");
    const req = buildRequest({ file: pngFile(), kind: "image", workspaceId: "ws-1" });
    const res = await POST(req);
    expect(res.status).toBe(503);
  });

  it("maps an unexpected failure to 500", async () => {
    mockPersistGeneratedAsset.mockRejectedValue(new Error("db exploded"));
    const { POST } = await import("./route");
    const req = buildRequest({ file: pngFile(), kind: "image", workspaceId: "ws-1" });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
