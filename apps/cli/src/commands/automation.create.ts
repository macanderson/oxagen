import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface AutomationCreateResponse {
  automation_id: string;
  playbook_id: string;
  name: string;
  status: string;
  triggerType: string;
  enabled: boolean;
}

export const automationCreateCommand = new Command("create")
  .description("Create a new automation")
  .requiredOption("-n, --name <name>", "Automation name")
  .option("-d, --description <text>", "What this automation does and when it fires")
  .option(
    "--trigger-type <type>",
    "Trigger type: event | schedule | api (default: api)",
    "api",
  )
  .option("--entity-type <type>", "Graph entity type to watch (required for event triggers)")
  .option(
    "--event-type <type>",
    "Graph event type: node.created | node.updated | node.deleted (required for event triggers)",
  )
  .option("--conditions <json>", "JSON array of propertyConditions for event triggers")
  .option(
    "--cron <expression>",
    "POSIX cron expression (required for schedule triggers, e.g. '0 9 * * 1')",
  )
  .option("--timezone <tz>", "IANA timezone for schedule triggers (default: UTC)")
  .option("--steps <json>", "JSON array of step objects to scaffold in the playbook")
  .option("--enabled", "Start the trigger enabled (human-origin only; AI calls are forced off)")
  .action(
    async (options: {
      name: string;
      description?: string;
      triggerType: string;
      entityType?: string;
      eventType?: string;
      conditions?: string;
      cron?: string;
      timezone?: string;
      steps?: string;
      enabled?: boolean;
    }) => {
      try {
        type TriggerConfig = {
          entityType?: string;
          eventType?: string;
          propertyConditions?: unknown;
          cronExpression?: string;
          timezone?: string;
        };

        const triggerConfig: TriggerConfig = {};
        if (options.entityType) triggerConfig.entityType = options.entityType;
        if (options.eventType) triggerConfig.eventType = options.eventType;
        if (options.conditions) {
          try {
            triggerConfig.propertyConditions = JSON.parse(options.conditions);
          } catch {
            throw new Error("Invalid --conditions JSON");
          }
        }
        if (options.cron) triggerConfig.cronExpression = options.cron;
        if (options.timezone) triggerConfig.timezone = options.timezone;

        let steps: unknown[] = [];
        if (options.steps) {
          try {
            steps = JSON.parse(options.steps) as unknown[];
          } catch {
            throw new Error("Invalid --steps JSON");
          }
        }

        console.log(`Creating automation "${options.name}"...`);
        const data = await apiRequest<AutomationCreateResponse>("/automation/create", {
          method: "POST",
          body: JSON.stringify({
            name: options.name,
            description: options.description,
            triggerType: options.triggerType,
            triggerConfig,
            steps,
            enabled: options.enabled ?? false,
          }),
        });
        console.log(`✓ Automation created`);
        console.log(`  ID: ${data.automation_id}`);
        console.log(`  Playbook ID: ${data.playbook_id}`);
        console.log(`  Name: ${data.name}`);
        console.log(`  Status: ${data.status}`);
        console.log(`  Trigger type: ${data.triggerType}`);
        console.log(`  Enabled: ${data.enabled}`);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );
