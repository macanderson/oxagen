import { Command } from "commander";
import * as readline from "node:readline";
import { apiRequest, ApiError } from "../lib/api-client.js";


interface EraseResponse {
  requestId: string;
  status: string;
  effectiveAt: string;
}

async function promptConfirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim() === "CONFIRM");
    });
  });
}

export const privacyEraseCommand = new Command("erase")
  .description("Request GDPR Art.17 data erasure (irreversible — requires confirmation)")
  .option("-s, --scope <scope>", "Erasure scope: user (default) or org", "user")
  .option("--org-id <id>", "Organization ID (required when --scope=org)")
  .option("-y, --yes", "Skip interactive confirmation (CI use only)")
  .action(async (options: { scope: string; orgId?: string; yes?: boolean }) => {
    if (options.scope !== "user" && options.scope !== "org") {
      console.error("Error: --scope must be 'user' or 'org'");
      process.exit(1);
    }
    if (options.scope === "org" && !options.orgId) {
      console.error("Error: --org-id is required when --scope=org");
      process.exit(1);
    }

    if (!options.yes) {
      const scopeLabel = options.scope === "org"
        ? `organization ${options.orgId}`
        : "your account";
      console.error(`\nWARNING: This will permanently erase all data for ${scopeLabel}.`);
      console.error("Sessions will be revoked immediately. Data deletion is scheduled asynchronously.\n");
      const confirmed = await promptConfirm(
        "Type CONFIRM to proceed (anything else cancels): ",
      );
      if (!confirmed) {
        console.error("Cancelled.");
        process.exit(0);
      }
    }

    try {
      const data = await apiRequest<EraseResponse>("/privacy/erase", {
        method: "POST",
        body: JSON.stringify({
          scope: options.scope,
          confirm: true,
          ...(options.orgId ? { orgId: options.orgId } : {}),
        }),
      });
      console.log(`Erasure request submitted. Request ID: ${data.requestId}`);
      console.log(`Status: ${data.status}`);
      if (process.stdout.isTTY) {
        console.log(`Scheduled: ${data.effectiveAt}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
