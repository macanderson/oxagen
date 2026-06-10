import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
}

interface WebSearchResponse {
  results: SearchResult[];
  totalResults: number;
  searchId: string;
}

export const webSearchCommand = new Command("search")
  .description("Search the web using Tavily and return ranked results")
  .argument("<query>", "Search query string (max 500 characters)")
  .option("-n, --max-results <n>", "Maximum number of results to return (1-10)", "5")
  .option("-d, --depth <depth>", 'Search depth: "basic" or "advanced"', "basic")
  .option("--include-domains <domains>", "Comma-separated list of domains to include")
  .option("--exclude-domains <domains>", "Comma-separated list of domains to exclude")
  .option("--json", "Output raw JSON")
  .action(async (
    query: string,
    options: {
      maxResults: string;
      depth: string;
      includeDomains?: string;
      excludeDomains?: string;
      json?: boolean;
    },
  ) => {
    try {
      const data = await apiRequest<WebSearchResponse>("/web/search", {
        method: "POST",
        body: JSON.stringify({
          query,
          maxResults: parseInt(options.maxResults, 10),
          searchDepth: options.depth,
          includeDomains: options.includeDomains
            ? options.includeDomains.split(",").map((d) => d.trim())
            : undefined,
          excludeDomains: options.excludeDomains
            ? options.excludeDomains.split(",").map((d) => d.trim())
            : undefined,
        }),
      });

      if (options.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(`\nSearch results for: "${query}"`);
      console.log(`Found ${data.totalResults} results (ID: ${data.searchId})\n`);

      for (const result of data.results) {
        console.log(`  ${result.title}`);
        console.log(`  ${result.url}`);
        if (result.publishedDate) {
          console.log(`  Published: ${result.publishedDate}`);
        }
        console.log(`  Score: ${result.score.toFixed(2)}`);
        console.log(`  ${result.content.slice(0, 200)}${result.content.length > 200 ? "..." : ""}`);
        console.log();
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
