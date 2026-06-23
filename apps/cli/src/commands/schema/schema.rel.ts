import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

interface RelUpsertOptions {
  schemaName: string;
  displayName: string;
  startLabel?: string;
  endLabel?: string;
  cardinality?: string;
  description?: string;
  json?: boolean;
}

interface RelDeleteOptions {
  schemaName: string;
  json?: boolean;
}

export const schemaRelUpsertCommand = new Command("upsert")
  .description("Create or update a relationship type on a schema (within the draft version)")
  .requiredOption("-s, --schema-name <name>", "Schema name")
  .argument("<name>", "Relationship type name (e.g. EMPLOYS, SIGNED_CONTRACT)")
  .requiredOption("-d, --display-name <name>", "Human-readable display name")
  .option("--start-label <label>", "Constraint: start node label (null = any)")
  .option("--end-label <label>", "Constraint: end node label (null = any)")
  .option("--cardinality <cardinality>", "Relationship cardinality: one_to_one | one_to_many | many_to_one | many_to_many")
  .option("--description <text>", "Relationship type description")
  .option("--json", "Output raw JSON")
  .action(async (name: string, options: RelUpsertOptions) => {
    requireAuth();
    try {
      const body: Record<string, unknown> = {
        schemaName: options.schemaName,
        name,
        displayName: options.displayName,
      };
      if (options.startLabel) body.startLabel = options.startLabel;
      if (options.endLabel) body.endLabel = options.endLabel;
      if (options.cardinality) body.cardinality = options.cardinality;
      if (options.description) body.description = options.description;

      const data = await apiRequest("/schema/relationship-types", {
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

export const schemaRelDeleteCommand = new Command("delete")
  .description("Remove a relationship type from the draft")
  .requiredOption("-s, --schema-name <name>", "Schema name")
  .argument("<name>", "Relationship type name to delete")
  .option("--json", "Output raw JSON")
  .action(async (name: string, options: RelDeleteOptions) => {
    requireAuth();
    try {
      const data = await apiRequest("/schema/relationship-types", {
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

export const schemaRelCommand = new Command("rel")
  .description("Manage schema relationship types");

schemaRelCommand.addCommand(schemaRelUpsertCommand);
schemaRelCommand.addCommand(schemaRelDeleteCommand);
