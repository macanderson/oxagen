// upload_assistant_attachment: store one file a person attaches to a message
// for the in-app assistant (#4690, ADR-222).
//
// The bytes are checked by the same function the turn uses to read them back
// (`checkAttachmentBytes` in @oxagen/agent), so a file that uploads is a file
// the turn accepts. The row is the person's own (`access_policy = user`,
// `source = user_upload`) and sits under `attachments/<org>/<workspace>/` in
// blob storage. It is linked to a conversation when a turn sends it.
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { assistantAttachmentUpload } from "@oxagen/oxagen/contracts/assistant.attachment.upload";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import {
  AttachmentRefusedError,
  checkAttachmentBytes,
} from "@oxagen/agent/runtime/assistant-attachments";
import { assertContractRole } from "./lib/capability-role-guard";
import {
  type AssetKind,
  persistGeneratedAsset,
} from "./generated-asset.persist";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function kindOf(mediaType: string): AssetKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === "text/csv") return "spreadsheet";
  return "document";
}

export const assistantAttachmentUploadHandler: CapabilityHandler<
  typeof assistantAttachmentUpload
> = async (input, ctx) => {
  await assertContractRole(assistantAttachmentUpload, ctx);
  const userId = await resolveActingUserId(ctx);
  if (!userId) {
    throw new HandlerError({
      code: "forbidden",
      reason: "no_principal",
      message:
        "An attachment belongs to a person, and no person signed this request.",
    });
  }
  // The contract caps the string's length, so this decode is bounded. A
  // string Buffer.from would half-read (stray characters, bad padding) is
  // refused rather than stored as whatever bytes survived.
  const data = input.data.replace(/\s+/g, "");
  if (data.length % 4 !== 0 || !BASE64.test(data)) {
    throw new AttachmentRefusedError("bytes_do_not_match_type");
  }
  const bytes = new Uint8Array(Buffer.from(data, "base64"));
  const checked = checkAttachmentBytes(input.mediaType, bytes);

  const persisted = await persistGeneratedAsset({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId,
    kind: kindOf(checked.mediaType),
    accessPolicy: "user",
    source: "user_upload",
    bytes,
    mimeType: checked.mediaType,
    prompt: "",
    model: "",
    displayName: input.name,
    keyPrefix: `attachments/${ctx.orgId}/${ctx.workspaceId}`,
    sha256: checked.sha256,
  });

  return {
    publicId: persisted.publicId,
    name: input.name,
    mediaType: checked.mediaType,
    sizeBytes: bytes.byteLength,
    sha256: checked.sha256,
  };
};
