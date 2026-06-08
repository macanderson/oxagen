import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const orgMemberInviteAcceptCommand = new Command("accept")
  .description("Accept an organization membership invitation")
  .requiredOption("-i, --invite-id <id>", "Invitation ID")
  .option("-c, --code <code>", "Invitation code")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/org/member/invite/accept", {
        method: "POST",
        body: JSON.stringify({
          inviteId: options.inviteId,
          code: options.code,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to accept invitation:", error);
      process.exit(1);
    }
  });
