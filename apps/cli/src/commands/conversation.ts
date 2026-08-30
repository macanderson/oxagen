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
 *
 * Output discipline (ADR-023 §4): `--json` emits one single-line JSON value on
 * stdout (shape preserved); the exported document / serve URL is the answer and
 * goes to stdout; a file-write confirmation is progress → stderr; a bad
 * `--format` exits 2 (usage) and an API failure exits 1 — both uniform stderr
 * error lines. Writer-parameterized, so it is REPL-bridge safe.
 */
import { writeFile } from "node:fs/promises";
import { apiGetOrThrow } from "../lib/api.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

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

/** Normalize the user-supplied --format flag ("md" is an alias for markdown); null when invalid. */
function normalizeFormat(raw: string | undefined): "markdown" | "pdf" | null {
  const format = (raw ?? "markdown").toLowerCase();
  if (format === "md" || format === "markdown") return "markdown";
  if (format === "pdf") return "pdf";
  return null;
}

export async function handleConversationExport(
  conversationId: string,
  opts: ConversationExportCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);

  const format = normalizeFormat(opts.format);
  if (!format) {
    process.exitCode = 2;
    out.error(
      `Invalid --format "${opts.format}". Use one of: md, markdown, pdf.`,
      "usage",
    );
    return;
  }

  let result: ConversationExportResponse;
  try {
    result = await apiGetOrThrow<ConversationExportResponse>(
      `conversations/${encodeURIComponent(conversationId)}/export`,
      { format },
    );
  } catch (err) {
    out.error(err, "api");
    return;
  }

  if (out.isJson) {
    out.data(result);
    return;
  }

  if (result.format === "markdown") {
    const content = result.content ?? "";
    if (opts.output) {
      await writeFile(opts.output, content, "utf8");
      // The document went to the file; keep stdout machine-pure and report the
      // write as progress on stderr.
      out.info(`Exported ${result.messageCount} messages to ${opts.output}`);
      return;
    }
    writer.write(content); // the exported document IS the answer → stdout
    return;
  }

  // PDF: the asset is stored privately; print the access-controlled serve URL.
  writer.write(`Exported ${result.messageCount} messages as PDF`);
  writer.write(`  filename: ${result.filename}`);
  writer.write(`  url:      ${result.url ?? "(unavailable)"}`);
}
