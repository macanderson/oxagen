import { beforeEach, describe, expect, it, vi } from "vitest";

// The role gate runs for real against the fixture; the default caller is an
// org Owner.
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({
  persist: vi.fn(async (_args: Record<string, unknown>) => ({
    id: "row-1",
    publicId: "gen_abc123",
  })),
}));

vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mocks.persist,
}));

import { AttachmentRefusedError } from "@oxagen/agent/runtime/assistant-attachments";
import { assistantAttachmentUploadHandler } from "./assistant.attachment.upload";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";
import { makeCTX, TEST_CTX as CTX } from "./test-utils/fixtures";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

function input(name: string, mediaType: string, bytes: Buffer | string) {
  const buf = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return { name, mediaType, data: buf.toString("base64") };
}

beforeEach(() => {
  resetRoleGate();
  mocks.persist.mockClear();
});

describe("upload_assistant_attachment", () => {
  it("stores a checked image as the person's own upload under the workspace's attachments prefix", async () => {
    const out = await assistantAttachmentUploadHandler(
      input("shot.png", "image/png", PNG),
      CTX,
    );
    expect(out).toEqual({
      publicId: "gen_abc123",
      name: "shot.png",
      mediaType: "image/png",
      sizeBytes: PNG.byteLength,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
        userId: CTX.userId,
        kind: "image",
        accessPolicy: "user",
        source: "user_upload",
        mimeType: "image/png",
        displayName: "shot.png",
        keyPrefix: `attachments/${CTX.orgId}/${CTX.workspaceId}`,
        sha256: out.sha256,
      }),
    );
  });

  it("files a CSV as a spreadsheet and Markdown as a document", async () => {
    await assistantAttachmentUploadHandler(
      input("d.csv", "text/csv", "a,b\n1,2"),
      CTX,
    );
    await assistantAttachmentUploadHandler(
      input("n.md", "text/markdown", "# notes"),
      CTX,
    );
    expect(mocks.persist.mock.calls.map((c) => c[0].kind)).toEqual([
      "spreadsheet",
      "document",
    ]);
  });

  it("stores the type the bytes carry, not the type the device declared", async () => {
    const out = await assistantAttachmentUploadHandler(
      input("photo.jpg", "image/jpeg", PNG),
      CTX,
    );
    expect(out.mediaType).toBe("image/png");
  });

  it("stores an API-key call as the key's creator", async () => {
    roleGate.roles = { org: "Owner", keyCreator: "creator-1" };
    await assistantAttachmentUploadHandler(
      input("a.txt", "text/plain", "hi"),
      makeCTX({ userId: null, apiKeyId: "key-1" }),
    );
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "creator-1" }),
    );
  });

  it("refuses bytes that do not match the declared type, and stores nothing (negative)", async () => {
    await expect(
      assistantAttachmentUploadHandler(
        input("x.png", "image/png", "MZ not an image"),
        CTX,
      ),
    ).rejects.toMatchObject({ reason: "bytes_do_not_match_type" });
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("refuses data that is not base64, rather than storing what survives a lenient decode (negative)", async () => {
    await expect(
      assistantAttachmentUploadHandler(
        { name: "a.txt", mediaType: "text/plain", data: "aGk*!" },
        CTX,
      ),
    ).rejects.toBeInstanceOf(AttachmentRefusedError);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("refuses a type off the list (negative)", async () => {
    await expect(
      assistantAttachmentUploadHandler(
        input("a.html", "text/html", "<script>x</script>"),
        CTX,
      ),
    ).rejects.toMatchObject({ reason: "type_not_allowed" });
  });

  it("refuses a caller who holds none of the contract's roles (negative)", async () => {
    roleGate.roles = { org: null, workspace: null };
    await expect(
      assistantAttachmentUploadHandler(input("a.txt", "text/plain", "hi"), CTX),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
