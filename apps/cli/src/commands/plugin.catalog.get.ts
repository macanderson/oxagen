import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  category: string;
}

interface CatalogResponse {
  plugins: CatalogItem[];
}

export const pluginCatalogGetCommand = new Command("catalog:browse")
  .description("Browse the plugin catalog")
  .option("-c, --category <cat>", "Filter by category")
  .action(async (options: { category?: string }) => {
    try {
      const params = new URLSearchParams();
      if (options.category) params.append("category", options.category);
      const data = await apiRequest<CatalogResponse>(
        `/plugin/catalog/get?${params}`,
        { method: "GET" }
      );
      console.log("Available Plugins:");
      data.plugins.forEach((p) => {
        console.log(`  ${p.name} (${p.id})`);
        console.log(`    ${p.description}`);
        console.log(`    Category: ${p.category}`);
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
