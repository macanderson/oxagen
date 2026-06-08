import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface AutomationTriggerResponse {
  execution_id: string;
  status: string;
}

export const automationTriggerCommand = new Command("trigger")
  .description("Trigger an automation by ID")
  .requiredOption("-a, --automation <id>", "Automation ID to trigger")
  .option("-p, --payload <json>", "Trigger payload as JSON")
  .action(async (options: { automation: string; payload?: string }) => {
    try {
      let payload: Record<string, unknown> = {};
      if (options.payload) {
        try {
          payload = JSON.parse(options.payload);
        } catch {
          throw new Error("Invalid payload JSON");
        }
      }
      console.log(`Triggering automation ${options.automation}...`);
      const data = await apiRequest<AutomationTriggerResponse>("/automation/trigger", {
        method: "POST",
        body: JSON.stringify({ automation_id: options.automation, payload }),
      });
      console.log(`✓ Automation triggered`);
      console.log(`  Execution ID: ${data.execution_id}`);
      console.log(`  Status: ${data.status}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
