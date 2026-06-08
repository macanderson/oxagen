import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";

export const orgMemberRemoveCommand = new Command("remove")
  .description("Remove a member from the organization")
  .argument("<email>", "Member email address")
  .option("--org <slug>", "Organization slug")
  .action(async (email: string, options: { org?: string }) => {
    requireAuth();
    try {
      await apiRequest("/org/members", {
        method: "DELETE",
        body: JSON.stringify({ email, org: options.org }),
      });
      console.log(`✓ Removed ${email} from organization`);
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
