import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";
import { readConfig } from "../lib/config.js";

interface MeResponse {
  user?: { email?: string; name?: string };
  org?: { name?: string; slug?: string };
  workspace?: { name?: string; slug?: string };
}

export const authWhoamiCommand = new Command("whoami")
  .description("Show current user and organization")
  .action(async () => {
    requireAuth();
    try {
      const data = await apiRequest<MeResponse>("/auth/me");
      const cfg = readConfig();
      if (process.stdout.isTTY) console.log(`User: ${data.user?.email ?? "unknown"}`);
      console.log(`Organization: ${data.org?.slug ?? cfg.orgSlug ?? "none"}`);
      console.log(`Workspace: ${data.workspace?.slug ?? cfg.workspaceSlug ?? "none"}`);
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
