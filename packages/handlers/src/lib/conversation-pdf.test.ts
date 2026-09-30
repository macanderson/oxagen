import { describe, expect, it } from "vitest";
import type { ConversationExportModel, ExportBlock } from "./conversation-markdown";
import { buildConversationPdf } from "./conversation-pdf";
import {
  MAX_EXPORT_PDF_BLOCKS,
  MAX_EXPORT_PDF_TEXT_BYTES,
} from "./conversation-export-limits";

function model(blocks: ExportBlock[]): ConversationExportModel {
  return {
    title: "Export",
    createdAt: new Date("2026-09-29T00:00:00Z"),
    exportedAt: new Date("2026-09-30T00:00:00Z"),
    orgName: null,
    workspaceName: null,
    totalMessageCount: 1,
    messages: [{ role: "user", createdAt: new Date(), blocks }],
  };
}

describe("conversation PDF limits", () => {
  it("counts UTF-8 bytes before rendering", async () => {
    await expect(buildConversationPdf(model([
      { kind: "text", text: "é".repeat(MAX_EXPORT_PDF_TEXT_BYTES / 2) },
    ]))).rejects.toThrow("128 KiB of PDF text");
  });

  it("bounds block count even when every block has empty text", async () => {
    const blocks: ExportBlock[] = Array.from(
      { length: MAX_EXPORT_PDF_BLOCKS + 1 },
      () => ({ kind: "text", text: "" }),
    );
    await expect(buildConversationPdf(model(blocks))).rejects.toThrow("2,000 PDF content blocks");
  });

  it("stops page allocation when a small newline-heavy payload exceeds 100 pages", async () => {
    await expect(buildConversationPdf(model([
      { kind: "text", text: "\n".repeat(6_000) },
    ]))).rejects.toThrow("100 PDF pages");
  });

  it("counts attachment URLs and tool results in the text budget", async () => {
    await expect(buildConversationPdf(model([
      { kind: "attachment", name: "file", url: "x".repeat(MAX_EXPORT_PDF_TEXT_BYTES / 2) },
      { kind: "tool", capability: "lookup", status: "done", resultPreview: "x".repeat(MAX_EXPORT_PDF_TEXT_BYTES / 2) },
    ]))).rejects.toThrow("128 KiB of PDF text");
  });

  it("rejects excessive message counts before rendering", async () => {
    const input = model([]);
    input.messages = Array.from({ length: 501 }, () => ({
      role: "user", createdAt: new Date(), blocks: [],
    }));
    await expect(buildConversationPdf(input)).rejects.toThrow("500 PDF messages");
  });
});
