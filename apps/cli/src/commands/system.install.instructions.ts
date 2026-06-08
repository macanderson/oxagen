import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface InstallStep {
  label: string;
  command?: string;
}

interface SystemInstallInstructionsResponse {
  client: string;
  steps: InstallStep[];
}

export const systemInstallInstructionsCommand = new Command("install-instructions")
  .description("Get step-by-step MCP/CLI installation instructions for an AI client")
  .requiredOption("-c, --client <client>", "AI client: claude-code, cursor, claude-desktop, codex, or vscode")
  .option("-w, --workspace <slug>", "Workspace slug for personalised config snippets")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { client: string; workspace?: string; org?: string }) => {
    try {
      const params = new URLSearchParams({ client: options.client });
      if (options.workspace) params.append("workspaceSlug", options.workspace);
      if (options.org) params.append("org_id", options.org);
      const data = await apiRequest<SystemInstallInstructionsResponse>(`/system/install/instructions?${params}`, {
        method: "GET",
      });
      console.log(`Installation instructions for ${data.client}:\n`);
      data.steps.forEach((step, i) => {
        console.log(`${i + 1}. ${step.label}`);
        if (step.command) console.log(`   $ ${step.command}`);
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
