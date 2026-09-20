import { z } from "zod";
import { SHA256_DIGEST_PATTERN } from "../digest";

export const ARP_MAX_BLOB_BYTES = 64 * 1024 * 1024;
export const ARP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const ARP_MAX_FILES = 10_000;

/** Reject names whose meaning changes across supported destination filesystems. */
export function safeRelativePath(path: string): string {
  if (!path || path.length > 4096 || /[\\:\x00-\x1f\x7f<>"|?*]/u.test(path)) {
    throw new Error(`Unsafe ARP path: ${JSON.stringify(path)}`);
  }
  for (const part of path.split("/")) {
    if (
      !part ||
      part === "." ||
      part === ".." ||
      /[. ]$/u.test(part) ||
      /^(?:\.git|\.arp)$/iu.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part) ||
      part.normalize("NFC") !== part ||
      /[\ud800-\udfff]/u.test(part)
    ) {
      throw new Error(`Unsafe ARP path: ${JSON.stringify(path)}`);
    }
  }
  return path;
}

const text = z.string().min(1).max(4096);
const digest = z.string().regex(SHA256_DIGEST_PATTERN);
const empty = z.array(z.never()).max(0);
const extensions = z.object({}).strict();
const path = text.refine((value) => {
  try {
    safeRelativePath(value);
    return true;
  } catch {
    return false;
  }
}, "Unsafe ARP workspace path");

export const blobRefSchema = z
  .object({
    digest,
    bytes: z.number().int().min(0).max(ARP_MAX_BLOB_BYTES),
    media_type: text,
  })
  .strict();

export const arpFrameSchema = z
  .object({
    format: z.literal("tacho/1.0"),
    issuer: text,
    stream_id: text,
    seq: z.string().regex(/^(0|[1-9][0-9]*)$/),
    digest,
  })
  .strict();

export const arpCheckpointSchema = z
  .object({
    schema: z.literal("arp.checkpoint/0.1"),
    checkpoint_id: text,
    issuer: text,
    profile: z.literal("code-workspace/0.1"),
    created_at: z.string().datetime({ offset: true }),
    source: z
      .object({
        boundary: arpFrameSchema,
        position: z.literal("after"),
        evidence_prefix: blobRefSchema,
      })
      .strict(),
    capture: z
      .object({
        boundary_kind: z.literal("turn_completed"),
        quiescence: z.enum(["client_attested", "runner_enforced"]),
        barrier_evidence: blobRefSchema,
        pending_operations: empty,
        active_children: empty,
      })
      .strict(),
    task: blobRefSchema,
    context: blobRefSchema,
    workspace: blobRefSchema,
    environment: blobRefSchema,
    tools: blobRefSchema,
    authority: blobRefSchema,
    effects: z
      .array(
        z
          .object({
            operation_id: text,
            status: z.enum(["settled", "unknown"]),
            receipt: blobRefSchema.optional(),
            external_ids: z.array(text).max(ARP_MAX_FILES),
            idempotency_key: text.optional(),
          })
          .strict(),
      )
      .max(ARP_MAX_FILES),
    gaps: z
      .array(
        z
          .object({
            code: text,
            dimension: z.enum([
              "workspace",
              "environment",
              "context",
              "tools",
              "effects",
              "authority",
              "evidence",
            ]),
            required: z.boolean(),
            detail: text,
            source: arpFrameSchema.optional(),
          })
          .strict(),
      )
      .max(ARP_MAX_FILES),
    extensions,
    required_extensions: empty,
  })
  .strict();

export const arpWorkspaceSchema = z
  .object({
    schema: z.literal("arp.workspace/0.1"),
    complete_scope: z.literal(true),
    repositories: z
      .array(
        z
          .object({
            root: z.union([z.literal("."), path]),
            provider_id: text,
            base_object: text,
          })
          .strict(),
      )
      .max(ARP_MAX_FILES),
    entries: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ path, kind: z.literal("directory") }).strict(),
          z
            .object({
              path,
              kind: z.literal("file"),
              blob: blobRefSchema,
              executable: z.boolean(),
            })
            .strict(),
        ]),
      )
      .max(ARP_MAX_FILES),
    // Exclusions describe omitted paths, including reserved metadata directories.
    exclusions: z
      .array(
        z.object({ path: text, reason: text, required: z.boolean() }).strict(),
      )
      .max(ARP_MAX_FILES),
    resources: empty,
    extensions,
    required_extensions: empty,
  })
  .strict();

export type BlobRef = z.infer<typeof blobRefSchema>;
export type ArpCheckpoint = z.infer<typeof arpCheckpointSchema>;
export type ArpWorkspace = z.infer<typeof arpWorkspaceSchema>;
