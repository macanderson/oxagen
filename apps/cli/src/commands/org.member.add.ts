import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

export const orgMemberAddCommand = new Command("add")
  .description("Add a member to the organization")
  .argument("<email>", "Member email address")
  .option("--org <slug>", "Organization slug")
  .option("--role <role>", "Member role (member | admin | owner)", "member")
  .action(async (email: string, options: { org?: string; role?: string }) => {
    requireAuth();
    try {
      await apiRequest("/org/members", {
        method: "POST",
        body: JSON.stringify({ email, org: options.org, role: options.role }),
      });
      console.log(`✓ Added ${email} as ${options.role ?? "member"}`);
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });
