import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface AutomationCreateResponse {
  automation_id: string;
  name: string;
  status: string;
}

export const automationCreateCommand = new Command("create")
  .description("Create a new automation")
  .requiredOption("-n, --name <name>", "Automation name")
  .option("-t, --trigger <event>", "Trigger event type")
  .option("-a, --action <type>", "Action type")
  .action(async (options: { name: string; trigger?: string; action?: string }) => {
    try {
      console.log(`Creating automation "${options.name}"...`);
      const data = await apiRequest<AutomationCreateResponse>("/automation/create", {
        method: "POST",
        body: JSON.stringify({
          name: options.name,
          trigger: options.trigger,
          action: options.action,
        }),
      });
      console.log(`✓ Automation created`);
      console.log(`  ID: ${data.automation_id}`);
      console.log(`  Name: ${data.name}`);
      console.log(`  Status: ${data.status}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
