import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

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
        body: JSON.stringify({ email, org: options.org ?? getOrgId(), role: options.role }),
      });
      console.log(`✓ Added ${email} as ${options.role ?? "member"}`);
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
