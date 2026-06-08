import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

interface ApiKeyResponse {
  key?: string;
  token?: string;
  id?: string;
  name?: string;
}

export const apiKeyCreateCommand = new Command("create")
  .description("Create an API key")
  .argument("<name>", "Key name")
  .option("--org <slug>", "Organization slug")
  .option("--workspace <slug>", "Workspace slug")
  .action(async (name: string, options: { org?: string; workspace?: string }) => {
    requireAuth();
    try {
      const data = await apiRequest<ApiKeyResponse>("/api-keys", {
        method: "POST",
        body: JSON.stringify({ name, org: options.org, workspace: options.workspace }),
      });
      const secret = data.key ?? data.token;
      console.log(`✓ API key created: ${data.id ?? "unknown"}`);
      if (secret) {
        // Only show the full secret in interactive TTY; redact in CI/pipes to prevent credential leakage to logs.
        const displaySecret = process.stdout.isTTY
          ? secret
          : `${secret.slice(0, 4)}...${secret.slice(-4)}`;
        console.log(`  Key: ${displaySecret}`);
      }
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });
