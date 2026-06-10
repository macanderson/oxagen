import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface OrgMemberInviteDeclineResponse {
  invitationPublicId: string;
  status: "declined";
}

export const orgMemberInviteDeclineCommand = new Command("decline")
  .description("Decline a pending org invitation")
  .requiredOption("-i, --invitation <id>", "Invitation public ID")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { invitation: string; org?: string }) => {
    try {
      const data = await apiRequest<OrgMemberInviteDeclineResponse>("/org/member/invite/decline", {
        method: "POST",
        body: JSON.stringify({
          invitationPublicId: options.invitation,
          org_id: options.org ?? getOrgId(),
        }),
      });
      console.log(`✓ Invitation ${data.invitationPublicId} ${data.status}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
