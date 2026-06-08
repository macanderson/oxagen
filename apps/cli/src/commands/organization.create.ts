import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface OrganizationCreateResponse {
  publicId: string;
  name: string;
  slug: string;
  type: string;
  createdAt: string;
}

export const organizationCreateCommand = new Command("create-org")
  .description("Create a new organization with a globally-unique slug")
  .requiredOption("-n, --name <name>", "Organization name")
  .requiredOption("-s, --slug <slug>", "Unique slug (lowercase letters, digits, hyphens)")
  .option("--plan <slug>", "Plan slug (default: free)", "free")
  .option("--type <type>", "Organization type: business or personal (default: business)", "business")
  .option("--website <url>", "Website URL (business accounts only)")
  .option("--billing-email <email>", "Billing email")
  .action(async (options: { name: string; slug: string; plan: string; type: string; website?: string; billingEmail?: string }) => {
    try {
      const data = await apiRequest<OrganizationCreateResponse>("/organization/create", {
        method: "POST",
        body: JSON.stringify({
          name: options.name,
          slug: options.slug,
          planSlug: options.plan,
          type: options.type,
          website: options.website,
          billingEmail: options.billingEmail,
        }),
      });
      console.log(`✓ Organization created`);
      console.log(`  ID:   ${data.publicId}`);
      console.log(`  Name: ${data.name}`);
      console.log(`  Slug: ${data.slug}`);
      console.log(`  Type: ${data.type}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
