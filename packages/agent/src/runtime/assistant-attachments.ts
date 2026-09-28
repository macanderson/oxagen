// The files a person attaches to an in-app agent turn (#4690, ADR-221).
//
// A file arrives once, through `upload_assistant_attachment`, which checks its
// bytes here and stores them in blob storage under the workspace. The turn
// names the stored files by public id; `loadTurnAttachments` reads them back
// under the tenant scope, checks the model can read each one, and hands the
// turn two things: the images and PDFs as model parts, and the text files as
// one block the instruction carries. Postgres keeps the row (name, type,
// size, SHA-256, storage key); ClickHouse and the message rows keep no bytes.
//
// Every check refuses with `AttachmentRefusedError`, whose `reason` names the
// rule the file broke and whose message says it in words a person can act on.
// The API maps it to a 400 (apps/api/src/middleware/error.ts).
import { createHash } from "node:crypto";
import { supportsVision } from "@oxagen/ai";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import {
  ASSISTANT_ATTACHMENT_MAX_BYTES,
  ASSISTANT_ATTACHMENT_MAX_FILES,
  ASSISTANT_ATTACHMENT_TEXT_TURN_MAX_BYTES,
  ASSISTANT_ATTACHMENT_TURN_MAX_BYTES,
  type AssistantAttachmentCategory,
  type AssistantAttachmentType,
  assistantAttachmentCategory,
} from "@oxagen/oxagen/contracts/assistant.attachment.upload";
import { StorageNotFoundError, storage } from "@oxagen/storage";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { GovernedTurnAttachment } from "./governed-turn";

export type AttachmentRefusalReason =
  | "type_not_allowed"
  | "too_large"
  | "too_many"
  | "turn_too_large"
  | "bytes_do_not_match_type"
  | "model_cannot_read_images"
  | "model_cannot_read_pdfs"
  | "not_found";

const REFUSAL_MESSAGES: Record<AttachmentRefusalReason, string> = {
  type_not_allowed:
    "This file type cannot be attached. Attach an image (PNG, JPEG, WebP or GIF), a PDF, or a text, Markdown, CSV or JSON file.",
  too_large:
    "This file is too large. Images and PDFs can be up to 4 MB, and text files up to 256 KB.",
  too_many: `A message can carry at most ${ASSISTANT_ATTACHMENT_MAX_FILES} files.`,
  turn_too_large:
    "These files are too large to send together. Images and PDFs can total 4 MB per message, and text files 256 KB.",
  bytes_do_not_match_type:
    "This file's contents do not match its type. Save it again in its own format and attach it again.",
  model_cannot_read_images:
    "The model this turn uses cannot read images. Choose a model that can, or remove the images.",
  model_cannot_read_pdfs:
    "The model this turn uses cannot read PDFs. Choose a model that can, or remove the PDFs.",
  not_found: "An attached file is no longer available. Attach it again.",
};

/** A file the attachment rules refuse. `reason` is the stable sub-code. */
export class AttachmentRefusedError extends Error {
  readonly code = "attachment_refused" as const;
  readonly reason: AttachmentRefusalReason;

  constructor(reason: AttachmentRefusalReason) {
    super(REFUSAL_MESSAGES[reason]);
    this.name = "AttachmentRefusedError";
    this.reason = reason;
  }
}

/**
 * The providers whose chat models read a PDF file part. Keyed by model-id
 * prefix, as `PROVIDER_TOOL_LIMITS` is, so a new model on one of them
 * inherits the answer. A provider absent here gets a refusal, never a guess.
 */
export const PDF_INPUT_PREFIXES = ["anthropic/", "openai/", "google/"] as const;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function startsWith(bytes: Uint8Array, sig: readonly number[], at = 0) {
  if (bytes.byteLength < at + sig.length) return false;
  return sig.every((b, i) => bytes[at + i] === b);
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

/**
 * The binary type the bytes' own signature names, or null when they carry
 * none of the allowed signatures. Text types have no signature to read.
 */
export function sniffAttachmentType(
  bytes: Uint8Array,
): AssistantAttachmentType | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a")))
    return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8))
    return "image/webp";
  if (startsWith(bytes, PDF)) return "application/pdf";
  return null;
}

function normalizeType(mediaType: string): string {
  return mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
}

/** Valid UTF-8 with no NUL, or null. A NUL marks a binary file. */
function decodeText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes("\u0000") ? null : text;
}

export interface CheckedAttachment {
  /** The type the bytes proved: the sniffed one, or the declared text type. */
  mediaType: AssistantAttachmentType;
  category: AssistantAttachmentCategory;
  /** Lowercase hex SHA-256 of the bytes. */
  sha256: string;
}

/**
 * Check a file's bytes against the type it claims. A binary signature wins
 * over the claim, so a PNG named `.jpg` is stored as a PNG. With no
 * signature, the claim must be a text type and the bytes must read as UTF-8
 * text (and JSON must parse). An image or PDF claim whose bytes carry no
 * signature is refused, because the model would be handed noise.
 */
export function checkAttachmentBytes(
  declaredType: string,
  bytes: Uint8Array,
): CheckedAttachment {
  const declared = normalizeType(declaredType);
  const declaredCategory = assistantAttachmentCategory(declared);
  const sniffed = sniffAttachmentType(bytes);
  let mediaType: AssistantAttachmentType;
  if (sniffed !== null) {
    mediaType = sniffed;
  } else if (declaredCategory === "text") {
    const text = decodeText(bytes);
    if (text === null)
      throw new AttachmentRefusedError("bytes_do_not_match_type");
    if (declared === "application/json") {
      try {
        JSON.parse(text);
      } catch {
        throw new AttachmentRefusedError("bytes_do_not_match_type");
      }
    }
    mediaType = declared as AssistantAttachmentType;
  } else if (declaredCategory !== null) {
    throw new AttachmentRefusedError("bytes_do_not_match_type");
  } else {
    throw new AttachmentRefusedError("type_not_allowed");
  }
  const category = assistantAttachmentCategory(mediaType);
  if (category === null) throw new AttachmentRefusedError("type_not_allowed");
  if (bytes.byteLength === 0) throw new AttachmentRefusedError("too_large");
  if (bytes.byteLength > ASSISTANT_ATTACHMENT_MAX_BYTES[category]) {
    throw new AttachmentRefusedError("too_large");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { mediaType, category, sha256 };
}

/**
 * Refuse a file the turn's model cannot read, before any byte is fetched. An
 * image needs a vision model; a PDF needs a vision model from a provider in
 * `PDF_INPUT_PREFIXES`. Text is inlined, so every model reads it.
 */
export function assertModelReadsAttachments(
  catalogId: string,
  categories: readonly AssistantAttachmentCategory[],
): void {
  const needsImages = categories.includes("image");
  const needsPdfs = categories.includes("pdf");
  if (!needsImages && !needsPdfs) return;
  const vision = supportsVision(catalogId);
  if (needsImages && !vision) {
    throw new AttachmentRefusedError("model_cannot_read_images");
  }
  if (
    needsPdfs &&
    (!vision || !PDF_INPUT_PREFIXES.some((p) => catalogId.startsWith(p)))
  ) {
    throw new AttachmentRefusedError("model_cannot_read_pdfs");
  }
}

/** The file's name, safe to quote inside an attribute. */
export function attachmentLabel(name: string): string {
  const cleaned = [...name]
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code > 0x1f && code !== 0x7f && !'"<>&'.includes(c);
    })
    .join("")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
}

/**
 * The text files as one block the instruction carries. A closing tag inside
 * a file is broken up so the file cannot end its own block early.
 */
export function inlineTextAttachments(
  files: readonly { name: string; mediaType: string; text: string }[],
): string {
  return files
    .map(
      (f) =>
        `<attachment name="${attachmentLabel(f.name)}" type="${f.mediaType}">\n${f.text.replaceAll("</attachment", "<\\/attachment")}\n</attachment>`,
    )
    .join("\n\n");
}

/** One stored file the turn carries, as the turn record names it. */
export interface TurnAttachmentRef {
  /** `generated_assets.id`, for linking the row to the message. */
  id: string;
  publicId: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
}

export interface LoadedTurnAttachments {
  /** Images and PDFs, as model parts. */
  parts: GovernedTurnAttachment[];
  /** The text files as one block, or "" when there are none. */
  inlineText: string;
  refs: TurnAttachmentRef[];
}

const EMPTY: LoadedTurnAttachments = { parts: [], inlineText: "", refs: [] };

async function readAll(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new AttachmentRefusedError("too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function nameOf(metadata: unknown, fallback: string): string {
  const name = (metadata as { displayName?: unknown } | null)?.displayName;
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
}

/**
 * Read the files a turn names, in the order it names them. Only the asking
 * person's own uploads in this workspace are found; any other id is refused
 * as `not_found`, whoever owns it. The model check runs before a byte is
 * fetched, and each file's bytes are checked again on the way out, so a row
 * edited behind the upload's back cannot hand the model a different type.
 */
export async function loadTurnAttachments(args: {
  scope: { orgId: string; workspaceId: string };
  userId: string;
  publicIds: readonly string[];
  catalogId: string;
}): Promise<LoadedTurnAttachments> {
  const ids = [...new Set(args.publicIds)];
  if (ids.length === 0) return EMPTY;
  if (ids.length > ASSISTANT_ATTACHMENT_MAX_FILES) {
    throw new AttachmentRefusedError("too_many");
  }
  const { orgId, workspaceId } = args.scope;
  const rows = await runInTenantScope(args.scope, () =>
    withTenantDb((tx) =>
      tx
        .select({
          id: schema.generatedAssets.id,
          publicId: schema.generatedAssets.publicId,
          storageKey: schema.generatedAssets.storageKey,
          mimeType: schema.generatedAssets.mimeType,
          sizeBytes: schema.generatedAssets.sizeBytes,
          metadata: schema.generatedAssets.metadata,
        })
        .from(schema.generatedAssets)
        .where(
          and(
            inArray(schema.generatedAssets.publicId, ids),
            eq(schema.generatedAssets.orgId, orgId),
            eq(schema.generatedAssets.workspaceId, workspaceId),
            eq(schema.generatedAssets.userId, args.userId),
            eq(schema.generatedAssets.source, "user_upload"),
            eq(schema.generatedAssets.status, "ready"),
            isNull(schema.generatedAssets.deletedAt),
          ),
        ),
    ),
  );
  const byId = new Map(rows.map((r) => [r.publicId, r]));
  const ordered = ids.map((id) => {
    const row = byId.get(id);
    if (!row) throw new AttachmentRefusedError("not_found");
    return row;
  });

  const categories = ordered.map((row) => {
    const category = assistantAttachmentCategory(row.mimeType);
    if (category === null) throw new AttachmentRefusedError("type_not_allowed");
    return category;
  });
  assertModelReadsAttachments(args.catalogId, categories);

  const store = storage();
  const parts: GovernedTurnAttachment[] = [];
  const texts: { name: string; mediaType: string; text: string }[] = [];
  const refs: TurnAttachmentRef[] = [];
  let binaryBytes = 0;
  let textBytes = 0;
  for (const [i, row] of ordered.entries()) {
    const category = categories[i] as AssistantAttachmentCategory;
    let bytes: Uint8Array;
    try {
      const object = await store.get(row.storageKey);
      bytes = await readAll(
        object.body,
        ASSISTANT_ATTACHMENT_MAX_BYTES[category],
      );
    } catch (err) {
      if (err instanceof StorageNotFoundError) {
        throw new AttachmentRefusedError("not_found");
      }
      throw err;
    }
    const checked = checkAttachmentBytes(row.mimeType, bytes);
    const name = nameOf(row.metadata, row.publicId);
    if (checked.category === "text") {
      textBytes += bytes.byteLength;
      if (textBytes > ASSISTANT_ATTACHMENT_TEXT_TURN_MAX_BYTES) {
        throw new AttachmentRefusedError("turn_too_large");
      }
      texts.push({
        name,
        mediaType: checked.mediaType,
        text: new TextDecoder().decode(bytes),
      });
    } else {
      binaryBytes += bytes.byteLength;
      if (binaryBytes > ASSISTANT_ATTACHMENT_TURN_MAX_BYTES) {
        throw new AttachmentRefusedError("turn_too_large");
      }
      parts.push({
        kind: checked.category === "image" ? "image" : "file",
        data: bytes,
        mediaType: checked.mediaType,
        filename: name,
      });
    }
    refs.push({
      id: row.id,
      publicId: row.publicId,
      name,
      mediaType: checked.mediaType,
      sizeBytes: bytes.byteLength,
    });
  }
  return { parts, inlineText: inlineTextAttachments(texts), refs };
}

/** The instruction the model reads: the typed text, then the text files. */
export function instructionWithAttachments(
  content: string,
  inlineText: string,
): string {
  return inlineText ? `${content}\n\n${inlineText}` : content;
}

/**
 * Point the turn's files at the person's message, so the thread can show
 * them and deleting the conversation can find them. A row already linked to
 * another message keeps its first link.
 */
export async function linkTurnAttachments(
  tx: Tx,
  args: {
    scope: { orgId: string; workspaceId: string };
    userId: string;
    rowIds: readonly string[];
    conversationId: string;
    messageId: string;
  },
): Promise<void> {
  if (args.rowIds.length === 0) return;
  await tx
    .update(schema.generatedAssets)
    .set({ conversationId: args.conversationId, messageId: args.messageId })
    .where(
      and(
        inArray(schema.generatedAssets.id, [...args.rowIds]),
        eq(schema.generatedAssets.orgId, args.scope.orgId),
        eq(schema.generatedAssets.workspaceId, args.scope.workspaceId),
        eq(schema.generatedAssets.userId, args.userId),
        isNull(schema.generatedAssets.conversationId),
      ),
    );
}
