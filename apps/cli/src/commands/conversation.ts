/**
 * `oxagen conversation export <id>` — export a conversation's active branch as
 * Markdown or a formatted PDF over the org-scoped /v1 API. Thin shell over the
 * conversation.export capability so the CLI stays in parity with the API, MCP,
 * and agent surfaces.
 *
 *   oxagen conversation export <id> --format md            # markdown → stdout
 *   oxagen conversation export <id> --format md -o out.md  # markdown → file
 *   oxagen conversation export <id> --format pdf           # prints serve URL
 *   oxagen conversation export <id> --json                 # raw JSON envelope
 */
import { writeFile } from "node:fs/promises";
import { apiGetOrThrow, ApiError } from "../lib/api.js";

/** Print an error and exit(1) — the one-shot CLI failure contract. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function handleApiError(err: unknown): never {
  if (err instanceof ApiError) fail(err.message);
  fail(err instanceof Error ? err.message : String(err));
}

interface ConversationExportResponse {
  format: "markdown" | "pdf";
  filename: string;
  content: string | null;
  url: string | null;
  messageCount: number;
}

export interface ConversationExportCliOptions {
  format?: string;
  output?: string;
  json?: boolean;
}

/** Normalize the user-supplied --format flag ("md" is an alias for markdown). */
function normalizeFormat(raw: string | undefined): "markdown" | "pdf" {
  const format = (raw ?? "markdown").toLowerCase();
  if (format === "md" || format === "markdown") return "markdown";
  if (format === "pdf") return "pdf";
  return fail(`Invalid --format "${raw}". Use one of: md, markdown, pdf.`);
}

export async function handleConversationExport(
  conversationId: string,
  opts: ConversationExportCliOptions,
): Promise<void> {
  const format = normalizeFormat(opts.format);
  let result: ConversationExportResponse;
  try {
    result = await apiGetOrThrow<ConversationExportResponse>(
      `conversations/${encodeURIComponent(conversationId)}/export`,
      { format },
    );
  } catch (err) {
    handleApiError(err);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (result.format === "markdown") {
    const content = result.content ?? "";
    if (opts.output) {
      await writeFile(opts.output, content, "utf8");
      process.stdout.write(
        `Exported ${result.messageCount} messages to ${opts.output}\n`,
      );
      return;
    }
    process.stdout.write(content);
    return;
  }

  // PDF: the asset is stored privately; print the access-controlled serve URL.
  process.stdout.write(`Exported ${result.messageCount} messages as PDF\n`);
  process.stdout.write(`  filename: ${result.filename}\n`);
  process.stdout.write(`  url:      ${result.url ?? "(unavailable)"}\n`);
}
