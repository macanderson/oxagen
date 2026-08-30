// markdown.generate.ts — persist a Markdown document as a first-class generated
// asset. Raw Markdown source (or a structured sections fallback) is encoded to
// UTF-8 bytes and uploaded to blob storage via persistGeneratedAsset(). No
// heavy dependencies: TextEncoder is a Web-standard global, available in Node.js
// ≥ 11 without any import.

import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  markdownGenerate,
  type MarkdownGenerateInput,
} from "@oxagen/oxagen/contracts/markdown.generate";
import { logger } from "./logger";
import { persistGeneratedAsset } from "./generated-asset.persist";
import { assetDisplayName } from "./lib/asset-filename";

// ── Markdown assembly ─────────────────────────────────────────────────────────

/**
 * Build a Markdown string from a title and optional structured sections. Used
 * only when the caller does not supply raw `markdown` source. The output is a
 * simple CommonMark document: an H1 title followed by H2 section headings and
 * plain paragraphs.
 */
function assembleMarkdown(
  title: string,
  sections: NonNullable<MarkdownGenerateInput["sections"]>,
): string {
  const lines: string[] = [`# ${title}`, ""];
  for (const section of sections) {
    if (section.heading) {
      lines.push(`## ${section.heading}`, "");
    }
    for (const para of section.paragraphs) {
      lines.push(para, "");
    }
  }
  // Remove the trailing empty line for a clean EOF.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** Encode a Markdown string to UTF-8 bytes (no external dep). */
function encodeMarkdown(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const markdownGenerateHandler: CapabilityHandler<
  typeof markdownGenerate
> = async (input, ctx) => {
  // Markdown persistence requires a real user identity for the asset's
  // ownership row (same guard as documents.generate).
  if (!ctx.userId) {
    throw new Error(
      "markdown.generate: userId is required — no user identity in context",
    );
  }

  const { title, markdown, sections } = input;
  const mimeType = "text/markdown";

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, title },
    "markdown.generate: starting",
  );

  // Resolve the source: prefer explicit `markdown`; fall back to assembled
  // sections; final fallback is an H1-only document from the title alone.
  const source =
    markdown ??
    (sections && sections.length > 0
      ? assembleMarkdown(title, sections)
      : `# ${title}`);

  const bytes = encodeMarkdown(source);

  const userId = ctx.userId; // narrowed to string by the guard above
  // Markdown is persisted under the DB `document` kind — the
  // generated_assets_kind_check constraint does not include a dedicated
  // "markdown" kind, and `text/markdown` is a textual document. The
  // client-facing render directive below still tags the attachment as
  // `kind: "markdown"` so the file-attachment component shows a Markdown icon.
  const asset = await persistGeneratedAsset({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId,
    kind: "document",
    mimeType,
    bytes,
    // Record the operation name and "local" as the model token (no LLM call).
    prompt: `Generate markdown: ${title}`,
    model: "local",
    // Persist the clean document title so the Conversation Files panel and the
    // download filename render "<title>.md", not the instruction-prefixed prompt.
    displayName: title,
    messageId: ctx.messageId ?? undefined,
    accessPolicy: "org",
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      publicId: asset.publicId,
      sizeBytes: asset.sizeBytes,
    },
    "markdown.generate: complete",
  );

  // URL-friendly slug filename, identical to what the Conversation Files panel
  // and the asset serving route produce (single source of truth).
  const filename = assetDisplayName({
    prompt: `Generate markdown: ${title}`,
    kind: "document",
    mimeType,
    publicId: asset.publicId,
    displayName: title,
  });

  return {
    assetId: asset.id,
    publicId: asset.publicId,
    kind: "markdown",
    mimeType,
    sizeBytes: asset.sizeBytes,
    url: asset.url,
    serveUrl: asset.serveUrl,
    render: {
      componentId: "file-attachment",
      props: {
        url: asset.serveUrl,
        name: filename,
        kind: "markdown",
        mimeType,
        sizeBytes: asset.sizeBytes,
      },
    },
  };
};
