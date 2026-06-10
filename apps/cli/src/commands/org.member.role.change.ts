import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface RoleChangeResponse {
  userId: string;
  role: string;
  updated: boolean;
}

export const orgMemberRoleChangeCommand = new Command("member:role-change")
  .description("Change a member's organization role")
  .requiredOption("-u, --user <id>", "User ID")
  .requiredOption("-r, --role <role>", "New role (owner|admin|member|viewer)")
  .option("-o, --org <id>", "Organization ID (defaults to current org)")
  .action(async (options: { user: string; role: string; org?: string }) => {
    try {
      const data = await apiRequest<RoleChangeResponse>(
        "/org/member/role-change",
        {
          method: "POST",
          body: JSON.stringify({
            user_id: options.user,
            role: options.role,
            org_id: options.org ?? getOrgId(),
          }),
        }
      );
      console.log(`✓ Role updated for ${options.user} to ${data.role}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
