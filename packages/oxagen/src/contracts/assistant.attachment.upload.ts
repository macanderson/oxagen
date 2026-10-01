/**
 * `upload_assistant_attachment`: store one file a person attaches to a message
 * for the in-app assistant, before the message is sent (#4690, ADR-222).
 *
 * The composer uploads each file as it is attached and sends the returned
 * `gen_` ids with the message in `ask_assistant`'s `attachments`. The turn
 * reads the bytes back and hands them to the model as image, file or text
 * parts. The upload is separate from the turn so the message body stays small
 * and a card can show its own progress and its own refusal.
 *
 * The handler checks the bytes, not the name: an image or a PDF must carry
 * its format's signature, and a text file must be valid UTF-8 (JSON must
 * parse). A file whose bytes do not match its type is refused with
 * `attachment_refused` and a reason. The bytes go to private blob storage
 * under `attachments/<org>/<workspace>/`. Postgres keeps the name, type, size,
 * SHA-256 and key in `content.generated_assets`, private to the person who
 * uploaded it. ClickHouse keeps nothing.
 *
 * The caps below follow from the engine's 8 MiB request limit: a turn carries
 * at most 4 MiB of file bytes, which is under 5.6 MiB as base64, and leaves
 * room for the instruction, the history and the tool list.
 *
 * Not on the `agent` surface: a person attaches a file, the model does not.
 * Not a governed action (`noBillingGate`): storing a file spends no tokens.
 * The roles are `ask_assistant`'s, because whoever may ask may attach.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/** Images every vision model the assistant runs on reads. */
export const ASSISTANT_ATTACHMENT_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

/** PDF, read by the providers in `PDF_INPUT_PREFIXES` (`@oxagen/agent`). */
export const ASSISTANT_ATTACHMENT_PDF_TYPES = ["application/pdf"] as const;

/** Text the turn inlines into the message, so every model reads it. */
export const ASSISTANT_ATTACHMENT_TEXT_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;

/** Every type the composer offers and the server accepts, in one list. */
export const ASSISTANT_ATTACHMENT_TYPES = [
  ...ASSISTANT_ATTACHMENT_IMAGE_TYPES,
  ...ASSISTANT_ATTACHMENT_PDF_TYPES,
  ...ASSISTANT_ATTACHMENT_TEXT_TYPES,
] as const;

export type AssistantAttachmentType =
  (typeof ASSISTANT_ATTACHMENT_TYPES)[number];

/** How the turn hands a type to the model. */
export type AssistantAttachmentCategory = "image" | "pdf" | "text";

const MIB = 1024 * 1024;

/** The largest file of each category, in bytes. */
export const ASSISTANT_ATTACHMENT_MAX_BYTES: Record<
  AssistantAttachmentCategory,
  number
> = {
  image: 4 * MIB,
  pdf: 4 * MIB,
  text: 256 * 1024,
};

/** The most files one message carries. */
export const ASSISTANT_ATTACHMENT_MAX_FILES = 10;

/**
 * The most file bytes one turn sends the engine, new and replayed together.
 * Base64 grows bytes by a third, so 4 MiB is 5.6 MiB on the wire, under the
 * engine's 8 MiB body limit with room for the rest of the turn.
 */
export const ASSISTANT_ATTACHMENT_TURN_MAX_BYTES = 4 * MIB;

/**
 * The most text one turn inlines from attached files. Text reaches the model
 * as tokens, so this bounds what a file adds to the prompt: 256 KiB is about
 * 64,000 tokens.
 */
export const ASSISTANT_ATTACHMENT_TEXT_TURN_MAX_BYTES = 256 * 1024;

/** The longest base64 string the upload accepts: 4 MiB of bytes. */
export const ASSISTANT_ATTACHMENT_BASE64_MAX_CHARS =
  Math.ceil((4 * MIB) / 3) * 4;

/** The longest file name kept, in characters. */
export const ASSISTANT_ATTACHMENT_NAME_MAX_CHARS = 200;

/** The category a type belongs to, or null when the type is not accepted. */
export function assistantAttachmentCategory(
  mediaType: string,
): AssistantAttachmentCategory | null {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if ((ASSISTANT_ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(type))
    return "image";
  if ((ASSISTANT_ATTACHMENT_PDF_TYPES as readonly string[]).includes(type))
    return "pdf";
  if ((ASSISTANT_ATTACHMENT_TEXT_TYPES as readonly string[]).includes(type))
    return "text";
  return null;
}

/** `gen_…`: an uploaded attachment, as this capability returns it. */
export const assistantAttachmentIdSchema = z
  .string()
  .max(64)
  .regex(/^gen_[0-9a-z]+$/, "An attachment id starts with gen_.");

/** One attachment as a message records it and `get_conversation` returns it. */
export const assistantAttachmentSchema = z
  .object({
    /** `gen_…`: the id the read route and `ask_assistant` take. */
    publicId: assistantAttachmentIdSchema,
    name: z.string().min(1).max(ASSISTANT_ATTACHMENT_NAME_MAX_CHARS),
    /** The type the server settled on from the bytes. */
    mediaType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    /** Lowercase hex SHA-256 of the stored bytes. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const assistantAttachmentUpload = registerCapability({
  name: "upload_assistant_attachment",
  domain: "assistant",
  description:
    "Store one image, PDF or text file a person attaches to a message for the in-app assistant, after checking its bytes match its type and size cap, and return the id the message sends in ask_assistant's attachments.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  inAppAssistant: true,
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: true,
  noBillingGate: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "conversation",
  },
  input: z
    .object({
      /** The file's name as the person's device gave it. Display only. */
      name: z
        .string()
        .trim()
        .min(1, "The file needs a name.")
        .max(
          ASSISTANT_ATTACHMENT_NAME_MAX_CHARS,
          `The file name is longer than ${ASSISTANT_ATTACHMENT_NAME_MAX_CHARS} characters.`,
        ),
      /**
       * The type the device declared. The server checks it against the bytes
       * and refuses a mismatch; it never trusts the name's extension.
       */
      mediaType: z.string().trim().min(1).max(127),
      /** The file's bytes, base64. At most 4 MiB once decoded. */
      data: z
        .string()
        .min(1, "The file is empty.")
        .max(
          ASSISTANT_ATTACHMENT_BASE64_MAX_CHARS,
          "The file is larger than 4 MB.",
        ),
    })
    .strict(),
  output: assistantAttachmentSchema,
});

export type AssistantAttachmentUploadInput = z.output<
  typeof assistantAttachmentUpload.input
>;
export type AssistantAttachmentUploadOutput = z.output<
  typeof assistantAttachmentUpload.output
>;
export type AssistantAttachment = z.output<typeof assistantAttachmentSchema>;
