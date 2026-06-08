import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";

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
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
