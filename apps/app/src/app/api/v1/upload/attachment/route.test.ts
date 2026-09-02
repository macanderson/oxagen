/**
 * route.test.ts — regression tests for POST /api/v1/upload/attachment.
 *
 * Covers the multipart contract the composer's chip-strip upload depends on:
 * auth, org/workspace membership (IDOR guard), MIME/size validation shared
 * with `asset.upload`, and the `conversationAssetItem`-shaped success
 * response the composer/stream-route/message-bubble all agree on.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSessionOrRedirect,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockPersistGeneratedAsset,
} = vi.hoisted(() => ({
  mockGetSessionOrRedirect: vi.fn(),
  mockResolveOrg: vi.fn(),
  mockResolveWorkspace: vi.fn(),
  mockAssertOrgMember: vi.fn(),
  mockPersistGeneratedAsset: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: mockGetSessionOrRedirect,
}));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("@oxagen/handlers", () => ({
  persistGeneratedAsset: mockPersistGeneratedAsset,
}));

import { POST } from "./route";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", publicId: "org_pub", name: "Acme", slug: "acme" };
const WORKSPACE = {
  id: "ws-1",
  publicId: "ws_pub",
  orgId: "org-1",
  name: "Main",
  slug: "main",
  description: "",
};

function pngFile(
  name = "screenshot.png",
  bytes = new Uint8Array([1, 2, 3, 4]),
): File {
  return new File([bytes], name, { type: "image/png" });
}

/** Build a multipart POST Request with the given fields. */
function req(fields: Record<string, string | File | undefined>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    form.set(key, value);
  }
  return new Request("https://app.oxagen.sh/api/v1/upload/attachment", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionOrRedirect.mockResolvedValue(SESSION);
  mockResolveOrg.mockResolvedValue(ORG);
  mockResolveWorkspace.mockResolvedValue(WORKSPACE);
  mockAssertOrgMember.mockResolvedValue(undefined);
  mockPersistGeneratedAsset.mockResolvedValue({
    id: "uuid-1",
    publicId: "gen_abc123",
    kind: "image",
    mimeType: "image/png",
    sizeBytes: 4,
    key: "generated/images/org-1/uuid.png",
    url: "https://blob.example/uuid.png",
    serveUrl: "/api/v1/assets/gen_abc123",
  });
});

describe("POST /api/v1/upload/attachment — success", () => {
  it("stores the file as a private user_upload asset and returns a conversationAssetItem", async () => {
    const res = await POST(
      req({
        file: pngFile(),
        kind: "image",
        orgSlug: "acme",
        workspaceSlug: "main",
        conversationId: "conv_1",
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      publicId: "gen_abc123",
      kind: "image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 4,
      status: "ready",
      accessPolicy: "org",
      url: "/api/v1/assets/gen_abc123",
    });
    // Never leak the raw blob URL to the client — only the access-controlled path.
    expect(body.url).not.toBe("https://blob.example/uuid.png");

    expect(mockPersistGeneratedAsset).toHaveBeenCalledTimes(1);
    expect(mockPersistGeneratedAsset.mock.calls[0]![0]).toMatchObject({
      orgId: ORG.id,
      workspaceId: WORKSPACE.id,
      userId: SESSION.user.id,
      kind: "image",
      accessPolicy: "org",
      mimeType: "image/png",
      prompt: "",
      model: "",
      displayName: "screenshot.png",
      conversationId: "conv_1",
      source: "user_upload",
    });
  });

  it("passes conversationId as null when the composer has no conversation yet", async () => {
    const res = await POST(
      req({
        file: pngFile(),
        kind: "image",
        orgSlug: "acme",
        workspaceSlug: "main",
      }),
    );

    expect(res.status).toBe(201);
    expect(mockPersistGeneratedAsset.mock.calls[0]![0]).toMatchObject({
      conversationId: null,
    });
  });
});

describe("POST /api/v1/upload/attachment — validation and auth", () => {
  it("returns 401 when there is no session", async () => {
    mockGetSessionOrRedirect.mockRejectedValueOnce(new Error("no session"));

    const res = await POST(
      req({
        file: pngFile(),
        kind: "image",
        orgSlug: "acme",
        workspaceSlug: "main",
      }),
    );

    expect(res.status).toBe(401);
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("returns 400 when file is missing", async () => {
    const res = await POST(
      req({ kind: "image", orgSlug: "acme", workspaceSlug: "main" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown kind", async () => {
    const res = await POST(
      req({
        file: pngFile(),
        kind: "avatar",
        orgSlug: "acme",
        workspaceSlug: "main",
      }),
    );
    expect(res.status).toBe(400);
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("returns 400 when orgSlug is missing", async () => {
    const res = await POST(
      req({ file: pngFile(), kind: "image", workspaceSlug: "main" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 415 for a disallowed MIME type", async () => {
    const badFile = new File([new Uint8Array([1])], "malware.exe", {
      type: "application/x-msdownload",
    });
    const res = await POST(
      req({
        file: badFile,
        kind: "image",
        orgSlug: "acme",
        workspaceSlug: "main",
      }),
    );
    expect(res.status).toBe(415);
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty file", async () => {
    const empty = new File([], "empty.png", { type: "image/png" });
    const res = await POST(
      req({
        file: empty,
        kind: "image",
        orgSlug: "acme",
        workspaceSlug: "main",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 413 when the file exceeds the kind's size limit", async () => {
    const huge = new File([new Uint8Array(6 * 1024 * 1024)], "huge.png", {
      type: "image/png",
    });
    const res = await POST(
      req({
        file: huge,
        kind: "image",
        orgSlug: "acme",
        workspaceSlug: "main",
      }),
    );
    expect(res.status).toBe(413);
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("returns 404 (IDOR guard) when org membership is denied", async () => {
    mockAssertOrgMember.mockRejectedValueOnce(new Error("not a member"));

    const res = await POST(
      req({
        file: pngFile(),
        kind: "image",
        orgSlug: "acme",
        workspaceSlug: "main",
      }),
    );

    expect(res.status).toBe(404);
    expect(mockPersistGeneratedAsset).not.toHaveBeenCalled();
  });

  it("returns a 500 when persistence fails", async () => {
    mockPersistGeneratedAsset.mockRejectedValueOnce(
      new Error("blob store down"),
    );

    const res = await POST(
      req({
        file: pngFile(),
        kind: "image",
        orgSlug: "acme",
        workspaceSlug: "main",
      }),
    );

    expect(res.status).toBe(500);
  });

  it("returns 503 when the blob token is misconfigured", async () => {
    mockPersistGeneratedAsset.mockRejectedValueOnce(
      new Error("BLOB_READ_WRITE_TOKEN is not set"),
    );

    const res = await POST(
      req({
        file: pngFile(),
        kind: "image",
        orgSlug: "acme",
        workspaceSlug: "main",
      }),
    );

    expect(res.status).toBe(503);
  });
});
