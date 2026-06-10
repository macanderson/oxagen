import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface WebFetchResponse {
  url: string;
  title: string;
  content: string;
  wordCount: number;
  fetchedAt: string;
  statusCode: number;
}

export const webFetchCommand = new Command("fetch")
  .description("Fetch a URL and return its content as clean markdown text")
  .argument("<url>", "URL to fetch (must be http:// or https://)")
  .option("--no-markdown", "Return raw HTML instead of extracted markdown")
  .option("-t, --timeout <ms>", "Request timeout in milliseconds (1000-30000)", "10000")
  .option("--json", "Output raw JSON")
  .action(async (
    url: string,
    options: {
      markdown: boolean;
      timeout: string;
      json?: boolean;
    },
  ) => {
    try {
      const data = await apiRequest<WebFetchResponse>("/web/fetch", {
        method: "POST",
        body: JSON.stringify({
          url,
          extractMarkdown: options.markdown,
          timeout: parseInt(options.timeout, 10),
        }),
      });

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(`\nFetched: ${data.url}`);
      if (data.title) {
        console.log(`Title: ${data.title}`);
      }
      console.log(`Status: ${data.statusCode}`);
      console.log(`Words: ${data.wordCount}`);
      console.log(`Fetched at: ${data.fetchedAt}`);
      console.log("\n---\n");
      console.log(data.content);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
