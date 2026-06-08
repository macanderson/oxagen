import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface WorkspaceInviteSendResponse {
  id: string;
  status: string;
  expires_at: string;
}

export const workspaceInviteSendCommand = new Command("send")
  .description("Send a workspace invitation")
  .requiredOption("-e, --email <email>", "Email address to invite")
  .option("-r, --role <role>", "Role to assign (member|admin|owner)", "member")
  .option("-m, --message <message>", "Optional personal message to include")
  .action(async (options: { email: string; role?: string; message?: string }) => {
    try {
      if (options.role && !["member", "admin", "owner"].includes(options.role)) {
        throw new Error("Role must be one of: member, admin, owner");
      }
      console.log(`Sending invitation to ${options.email}...`);
      const data = await apiRequest<WorkspaceInviteSendResponse>(
        "/workspace/invite/send",
        {
          method: "POST",
          body: JSON.stringify({
            email: options.email,
            role: options.role ?? "member",
            message: options.message,
          }),
        }
      );
      console.log(`✓ Invitation sent`);
      console.log(`  ID:         ${data.id}`);
      console.log(`  Status:     ${data.status}`);
      console.log(`  Expires at: ${data.expires_at}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
