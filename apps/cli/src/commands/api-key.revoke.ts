import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

export const apiKeyRevokeCommand = new Command("revoke")
  .description("Revoke an API key")
  .argument("<id>", "API key ID to revoke")
  .action(async (id: string) => {
    requireAuth();
    try {
      await apiRequest(`/api-keys/${id}`, { method: "DELETE" });
      console.log(`✓ API key ${id} revoked`);
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });
