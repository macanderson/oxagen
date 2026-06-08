import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

interface Org {
  id?: string;
  slug?: string;
  name?: string;
}

interface OrgsResponse {
  organizations?: Org[];
  data?: Org[];
}

export const orgListCommand = new Command("list")
  .description("List organizations")
  .action(async () => {
    requireAuth();
    try {
      const data = await apiRequest<OrgsResponse>("/organizations");
      const orgs = data.organizations ?? data.data ?? [];
      if (orgs.length === 0) {
        console.log("No organizations found.");
        return;
      }
      console.log("Organizations:");
      for (const org of orgs) {
        console.log(`  - ${org.slug ?? org.id ?? "unknown"} (${org.name ?? ""})`);
      }
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });
