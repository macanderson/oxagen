import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";

// Local response shape mirroring the conversation.files.list contract output.
// The CLI declares its own response types (it does not resolve deep contract
// type paths in its tsconfig/eslint context) — same pattern as the other
// generation commands (e.g. markdown.generate.ts).
interface ConversationFileItem {
  publicId: string;
  kind: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  status: string;
  accessPolicy: string;
  createdAt: string;
  url: string;
}

interface FilesListResponse {
  files: ConversationFileItem[];
  nextCursor: string | null;
}

export const conversationFilesListCommand = new Command("files")
  .description("List generated files attached to a conversation")
  .requiredOption("-c, --conversation <id>", "Conversation public ID")
  .option("--kind <kind>", "Filter by kind: image|video|document|spreadsheet|presentation|pdf|archive")
  .option("--limit <n>", "Maximum results (1–200)", "50")
  .option("--cursor <cursor>", "Pagination cursor (ISO createdAt of last row)")
  .action(
    async (options: {
      conversation: string;
      kind?: string;
      limit?: string;
      cursor?: string;
    }) => {
      requireAuth();
      try {
        const qs = new URLSearchParams();
        if (options.kind) qs.set("kind", options.kind);
        if (options.limit) qs.set("limit", options.limit);
        if (options.cursor) qs.set("cursor", options.cursor);
        const data = await apiRequest<FilesListResponse>(
          `/conversations/${options.conversation}/files?${qs}`,
        );
        if (data.files.length === 0) {
          console.log("No files found.");
          return;
        }
        console.log("Files:");
        for (const f of data.files) {
          const size =
            f.sizeBytes !== null ? ` (${Math.round(f.sizeBytes / 1024)}KB)` : "";
          console.log(
            `  ${f.publicId}  [${f.kind}]  ${f.name}${size}  ${f.createdAt}`,
          );
        }
        if (data.nextCursor) {
          console.log(`\nNext cursor: ${data.nextCursor}`);
        }
      } catch (err) {
        const _msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${_msg}`);
        process.exit(1);
      }
    },
  );
