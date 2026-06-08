import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface DocumentReadResponse {
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export const documentReadCommand = new Command("read")
  .description("Read a document by ID")
  .requiredOption("-d, --document <id>", "Document ID to read")
  .action(async (options: { document: string }) => {
    try {
      const params = new URLSearchParams({ document_id: options.document });
      const data = await apiRequest<DocumentReadResponse>(`/document/read?${params.toString()}`);
      console.log(`Title: ${data.title}`);
      console.log(`Created: ${data.created_at}`);
      if (Object.keys(data.metadata).length > 0) {
        console.log(`Metadata: ${JSON.stringify(data.metadata)}`);
      }
      console.log(`\n${data.content}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
