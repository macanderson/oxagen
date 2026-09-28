// The rules a file on the assistant's composer meets before it is sent, and
// the upload that stores it (#4690, ADR-222).
//
// The composer checks each file against the same contract constants the
// server enforces, so a file the server would refuse shows its problem on
// its own chip before anything is uploaded. The server checks again at
// upload and at send: these checks save a round trip, and they are not the
// gate.
//
// A file is uploaded as soon as it is attached, to
// `POST /v1/:org/:ws/assistant/attachments/upload` through the app's
// same-origin `/api/v1/*` rewrite, as the stream client reaches the chat
// route. The message then names the file by its `gen_` id.
import { z } from "zod";
import {
  ASSISTANT_ATTACHMENT_MAX_BYTES,
  ASSISTANT_ATTACHMENT_MAX_FILES,
  ASSISTANT_ATTACHMENT_NAME_MAX_CHARS,
  ASSISTANT_ATTACHMENT_TEXT_TURN_MAX_BYTES,
  ASSISTANT_ATTACHMENT_TURN_MAX_BYTES,
  ASSISTANT_ATTACHMENT_TYPES,
  assistantAttachmentCategory,
  assistantAttachmentIdSchema,
  type AssistantAttachmentCategory,
} from "@oxagen/oxagen/contracts/assistant.attachment.upload";

/** Where a file is on its way to the message. */
export type AttachmentFileState = "uploading" | "error" | "done";

/**
 * Why a file cannot be sent. Each one has its own sentence on the chip.
 *
 * - `type`: the type is off the list.
 * - `size`: the file is over its type's cap.
 * - `empty`: the file has no bytes.
 * - `count`: the message already carries the most files it can.
 * - `total`: the message's files together would be over the turn's cap.
 * - `bytes`: the server read the bytes and they do not carry the type.
 * - `upload`: the upload failed for any other reason.
 */
export type AttachmentProblem =
  | "type"
  | "size"
  | "empty"
  | "count"
  | "total"
  | "bytes"
  | "upload";

/** One file on the composer. */
export type AttachmentFile = {
  /** The composer's own key for the chip, unique for the page's life. */
  key: string;
  name: string;
  mediaType: string;
  /** Bytes, as the device reported them. */
  size: number;
  state: AttachmentFileState;
  /** The `gen_` id, once the upload stored the file. */
  publicId: string | null;
  problem: AttachmentProblem | null;
};

/** A file the message carries, as the transcript shows it after the send. */
export type SentAttachment = Pick<
  AttachmentFile,
  "key" | "name" | "mediaType" | "size"
> & { publicId: string };

/** The `accept` list of the file picker: every type, and the extensions a device may not type. */
export const ASSISTANT_ATTACHMENT_ACCEPT = [
  ...ASSISTANT_ATTACHMENT_TYPES,
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".txt",
].join(",");

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/**
 * The type to declare for a file. A device often reports Markdown and CSV
 * as nothing, or as a type off the list, so an unknown type falls back to
 * the extension. The server reads the bytes either way.
 */
export function mediaTypeOf(file: { name: string; type: string }): string {
  const declared = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared !== "" && assistantAttachmentCategory(declared) !== null) {
    return declared;
  }
  const dot = file.name.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.name.slice(dot + 1).toLowerCase();
  return TYPE_BY_EXTENSION[extension] ?? (declared || "application/octet-stream");
}

/** A file name cut to the contract's cap, so the upload never refuses it for length. */
function nameOf(name: string): string {
  const trimmed = name.trim() || "file";
  return trimmed.length > ASSISTANT_ATTACHMENT_NAME_MAX_CHARS
    ? trimmed.slice(0, ASSISTANT_ATTACHMENT_NAME_MAX_CHARS)
    : trimmed;
}

/** The rule a file breaks, given what the message already carries, or null. */
function problemOfFile(
  size: number,
  category: AssistantAttachmentCategory | null,
  carried: { count: number; text: number; binary: number },
): AttachmentProblem | null {
  if (category === null) return "type";
  if (size === 0) return "empty";
  if (size > ASSISTANT_ATTACHMENT_MAX_BYTES[category]) return "size";
  if (carried.count >= ASSISTANT_ATTACHMENT_MAX_FILES) return "count";
  if (category === "text") {
    return carried.text + size > ASSISTANT_ATTACHMENT_TEXT_TURN_MAX_BYTES
      ? "total"
      : null;
  }
  return carried.binary + size > ASSISTANT_ATTACHMENT_TURN_MAX_BYTES
    ? "total"
    : null;
}

/**
 * The chips for newly attached files, in the order given. A file that breaks
 * a rule is an `error` chip with its problem, and uploads nothing. The rest
 * are `uploading`. Files already on the composer count toward the message's
 * caps, apart from the ones already in error, which will not be sent.
 */
export function planAttachments(
  existing: readonly AttachmentFile[],
  files: readonly { name: string; type: string; size: number }[],
  nextKey: () => string,
): AttachmentFile[] {
  const kept = existing.filter((f) => f.state !== "error");
  let count = kept.length;
  let binary = 0;
  let text = 0;
  for (const f of kept) {
    if (assistantAttachmentCategory(f.mediaType) === "text") text += f.size;
    else binary += f.size;
  }
  return files.map((file): AttachmentFile => {
    const mediaType = mediaTypeOf(file);
    const category = assistantAttachmentCategory(mediaType);
    const base = {
      key: nextKey(),
      name: nameOf(file.name),
      mediaType,
      size: file.size,
      publicId: null,
    };
    const problem = problemOfFile(file.size, category, {
      count,
      text,
      binary,
    });
    if (problem !== null) return { ...base, state: "error", problem };
    count += 1;
    if (category === "text") text += file.size;
    else binary += file.size;
    return { ...base, state: "uploading", problem: null };
  });
}

/** The file's bytes as base64, without the data URL's prefix. */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      resolve(comma === -1 ? "" : url.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

const storedSchema = z.object({
  publicId: assistantAttachmentIdSchema,
  mediaType: z.string(),
});

const refusalSchema = z.object({
  error: z.object({ code: z.string().optional(), reason: z.string().optional() }),
});

/** The chip's problem for a refused upload, read from the route's envelope. */
export function problemOfUpload(status: number, body: unknown): AttachmentProblem {
  if (status === 413) return "size";
  const parsed = refusalSchema.safeParse(body);
  if (!parsed.success || parsed.data.error.code !== "attachment_refused") {
    return "upload";
  }
  switch (parsed.data.error.reason) {
    case "type_not_allowed":
      return "type";
    case "too_large":
      return "size";
    case "bytes_do_not_match_type":
      return "bytes";
    default:
      return "upload";
  }
}

export type UploadResult =
  | { ok: true; publicId: string; mediaType: string }
  | { ok: false; problem: AttachmentProblem };

/**
 * Stores one file for the person, in the workspace they are in. Never
 * rejects: a network failure is the `upload` problem.
 */
export async function uploadAssistantAttachment(
  org: string,
  ws: string,
  file: { name: string; mediaType: string; data: string },
): Promise<UploadResult> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/${encodeURIComponent(org)}/${encodeURIComponent(ws)}/assistant/attachments/upload`,
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(file),
      },
    );
  } catch {
    return { ok: false, problem: "upload" };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return { ok: false, problem: problemOfUpload(response.status, body) };
  }
  const stored = storedSchema.safeParse(body);
  return stored.success
    ? { ok: true, ...stored.data }
    : { ok: false, problem: "upload" };
}
