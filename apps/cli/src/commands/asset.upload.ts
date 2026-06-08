import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface AssetUploadResponse {
  url: string;
  key: string;
  contentType: string;
  bytes: number;
}

export const assetUploadCommand = new Command("upload")
  .description("Ingest a binary asset from a URL into object storage")
  .requiredOption("-s, --source <url>", "Source URL of the asset to ingest")
  .requiredOption("-k, --kind <kind>", "Asset kind: avatar, image, or document")
  .option("-f, --filename <name>", "Original filename (display only)")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { source: string; kind: string; filename?: string; org?: string }) => {
    try {
      const data = await apiRequest<AssetUploadResponse>("/asset/upload", {
        method: "POST",
        body: JSON.stringify({
          sourceUrl: options.source,
          kind: options.kind,
          filename: options.filename,
          org_id: options.org,
        }),
      });
      console.log(`✓ Asset uploaded`);
      console.log(`  URL:  ${data.url}`);
      console.log(`  Key:  ${data.key}`);
      console.log(`  Type: ${data.contentType} (${data.bytes} bytes)`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
