import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface AutomationUpdateResponse {
  automation_id: string;
  name: string;
  description: string | null;
  status: string;
  triggerType: string;
  enabled: boolean;
}

export const automationUpdateCommand = new Command("update")
  .description("Edit an existing automation: rename, change description, or replace trigger config")
  .argument("<id>", "Automation trigger public ID")
  .option("-n, --name <name>", "New name")
  .option("-d, --description <description>", "New description")
  .option("--trigger-config <json>", "Replacement trigger config as a JSON string")
  .action(
    async (
      id: string,
      opts: { name?: string; description?: string; triggerConfig?: string },
    ) => {
      try {
        const body: Record<string, unknown> = { automation_id: id };
        if (opts.name !== undefined) body.name = opts.name;
        if (opts.description !== undefined) body.description = opts.description;
        if (opts.triggerConfig !== undefined) {
          try {
            body.triggerConfig = JSON.parse(opts.triggerConfig);
          } catch {
            console.error("Error: --trigger-config must be valid JSON");
            process.exit(1);
          }
        }
        console.log(`Updating automation ${id}...`);
        const data = await apiRequest<AutomationUpdateResponse>("/automation/update", {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        console.log(`✓ Automation updated`);
        console.log(`  ID: ${data.automation_id}`);
        console.log(`  Name: ${data.name}`);
        console.log(`  Status: ${data.status}`);
        console.log(`  Trigger: ${data.triggerType} (enabled: ${data.enabled})`);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );
