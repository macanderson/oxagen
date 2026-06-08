import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface DocumentsPdfCreateResponse {
  assetId: string;
  publicId: string;
  kind: "pdf";
  mimeType: string;
  sizeBytes: number;
  url: string;
  serveUrl: string;
}

export const documentsPdfCreateCommand = new Command("pdf-create")
  .description("Generate a PDF from title and structured text content")
  .requiredOption("-t, --title <title>", "PDF title / filename")
  .option("--content <json>", "Content sections as JSON: {sections: [{heading?, paragraphs: string[]}]}")
  .option("--brand-colors <json>", "Brand colors as JSON: {primary?, secondary?}")
  .option("-o, --org <id>", "Organization ID")
  .option("-w, --workspace <id>", "Workspace ID")
  .action(async (options: { title: string; content?: string; brandColors?: string; org?: string; workspace?: string }) => {
    try {
      let content: unknown;
      let brandColors: unknown;
      if (options.content) content = JSON.parse(options.content) as unknown;
      if (options.brandColors) brandColors = JSON.parse(options.brandColors) as unknown;

      const data = await apiRequest<DocumentsPdfCreateResponse>("/documents/pdf/create", {
        method: "POST",
        body: JSON.stringify({
          title: options.title,
          content,
          brandColors,
          org_id: options.org,
          workspace_id: options.workspace,
        }),
      });
      console.log(`✓ PDF created`);
      console.log(`  Asset ID: ${data.assetId}`);
      console.log(`  Size:     ${data.sizeBytes} bytes`);
      console.log(`  URL:      ${data.serveUrl}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
