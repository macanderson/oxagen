import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";

interface MarkdownGenerateResponse {
  assetId: string;
  publicId: string;
  kind: "markdown";
  mimeType: string;
  sizeBytes: number;
  url: string;
  serveUrl: string;
}

export const markdownGenerateCommand = new Command("markdown-generate")
  .description("Persist a Markdown document as a generated asset")
  .requiredOption("-t, --title <title>", "Document title / filename (without .md extension)")
  .option("-m, --markdown <source>", "Raw Markdown source (use --sections as fallback)")
  .option(
    "--sections <json>",
    "Structured sections as JSON: [{heading?, paragraphs: string[]}]",
  )
  .option("-o, --org <id>", "Organization ID")
  .option("-w, --workspace <id>", "Workspace ID")
  .action(
    async (options: {
      title: string;
      markdown?: string;
      sections?: string;
      org?: string;
      workspace?: string;
    }) => {
      try {
        let sections: unknown;
        if (options.sections) sections = JSON.parse(options.sections) as unknown;

        const data = await apiRequest<MarkdownGenerateResponse>("/markdown/generate", {
          method: "POST",
          body: JSON.stringify({
            title: options.title,
            markdown: options.markdown,
            sections,
            org_id: options.org ?? getOrgId(),
            workspace_id: options.workspace ?? getWorkspaceId(),
          }),
        });

        console.log(`Markdown document created`);
        console.log(`  Asset ID: ${data.assetId}`);
        console.log(`  Size:     ${data.sizeBytes} bytes`);
        console.log(`  URL:      ${data.serveUrl}`);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );
