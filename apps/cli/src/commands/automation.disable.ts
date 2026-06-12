import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface AutomationDisableResponse {
  automation_id: string;
  enabled: boolean;
  status: string;
}

export const automationDisableCommand = new Command("disable")
  .description("Disable an automation trigger so it stops firing")
  .argument("<id>", "Automation trigger public ID")
  .action(async (id: string) => {
    try {
      console.log(`Disabling automation ${id}...`);
      const data = await apiRequest<AutomationDisableResponse>("/automation/disable", {
        method: "POST",
        body: JSON.stringify({ automation_id: id }),
      });
      console.log(`✓ Automation disabled`);
      console.log(`  ID: ${data.automation_id}`);
      console.log(`  Enabled: ${data.enabled}`);
      console.log(`  Status: ${data.status}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
