import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

interface LabelUpsertOptions {
  schemaName: string;
  displayName: string;
  description?: string;
  naturalKeyProps?: string;
  json?: boolean;
}

interface LabelDeleteOptions {
  schemaName: string;
  json?: boolean;
}

export const schemaLabelUpsertCommand = new Command("upsert")
  .description("Create or update a node label on a schema (within the draft version)")
  .requiredOption("-s, --schema-name <name>", "Schema name")
  .argument("<name>", "Node label name (e.g. Customer, Contract)")
  .requiredOption("-d, --display-name <name>", "Human-readable display name")
  .option("--description <text>", "Label description")
  .option("--natural-key-props <keys>", "Comma-separated property names forming the dedup natural key")
  .option("--json", "Output raw JSON")
  .action(async (name: string, options: LabelUpsertOptions) => {
    requireAuth();
    try {
      const body: Record<string, unknown> = {
        schemaName: options.schemaName,
        name,
        displayName: options.displayName,
      };
      if (options.description) body.description = options.description;
      if (options.naturalKeyProps) {
        body.naturalKeyProps = options.naturalKeyProps.split(",").map((s) => s.trim());
      }

      const data = await apiRequest("/schema/labels", {
        method: "POST",
        body: JSON.stringify(body),
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

export const schemaLabelDeleteCommand = new Command("delete")
  .description("Remove a node label and its properties from the draft")
  .requiredOption("-s, --schema-name <name>", "Schema name")
  .argument("<name>", "Node label name to delete")
  .option("--json", "Output raw JSON")
  .action(async (name: string, options: LabelDeleteOptions) => {
    requireAuth();
    try {
      const data = await apiRequest("/schema/labels", {
        method: "DELETE",
        body: JSON.stringify({ schemaName: options.schemaName, name }),
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

export const schemaLabelCommand = new Command("label")
  .description("Manage schema node labels");

schemaLabelCommand.addCommand(schemaLabelUpsertCommand);
schemaLabelCommand.addCommand(schemaLabelDeleteCommand);
