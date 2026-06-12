import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface AutomationEnableResponse {
  automation_id: string;
  enabled: boolean;
  status: string;
}

export const automationEnableCommand = new Command("enable")
  .description("Enable an automation trigger so it fires live")
  .argument("<id>", "Automation trigger public ID")
  .action(async (id: string) => {
    try {
      console.log(`Enabling automation ${id}...`);
      const data = await apiRequest<AutomationEnableResponse>("/automation/enable", {
        method: "POST",
        body: JSON.stringify({ automation_id: id }),
      });
      console.log(`✓ Automation enabled`);
      console.log(`  ID: ${data.automation_id}`);
      console.log(`  Enabled: ${data.enabled}`);
      console.log(`  Status: ${data.status}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
