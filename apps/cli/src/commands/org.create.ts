import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

interface OrgResponse {
  organization?: { slug?: string; id?: string; name?: string };
  slug?: string;
}

export const orgCreateCommand = new Command("create")
  .description("Create a new organization")
  .argument("<name>", "Organization name")
  .option("--slug <slug>", "Org slug (defaults to slugified name)")
  .action(async (name: string, options: { slug?: string }) => {
    requireAuth();
    try {
      const data = await apiRequest<OrgResponse>("/organizations", {
        method: "POST",
        body: JSON.stringify({ name, slug: options.slug }),
      });
      const org = data.organization ?? data;
      console.log(`✓ Organization created: ${(org as OrgResponse["organization"])?.slug ?? (org as OrgResponse).slug ?? "unknown"}`);
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });
