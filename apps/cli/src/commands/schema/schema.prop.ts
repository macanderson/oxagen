import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

const DATA_TYPES = ["string", "number", "boolean", "date", "datetime", "list", "object"] as const;

interface PropUpsertOptions {
  ownerKind: string;
  ownerName: string;
  dataType: string;
  required?: boolean;
  description?: string;
  enumValues?: string;
  itemType?: string;
  example?: string;
  json?: boolean;
}

interface PropDeleteOptions {
  ownerKind: string;
  ownerName: string;
  json?: boolean;
}

export const schemaPropUpsertCommand = new Command("upsert")
  .description("Create or update a property on a node label or relationship type in the draft")
  .argument("<key>", "Property name/key")
  .requiredOption("--owner-kind <kind>", "Owner kind: node | relationship")
  .requiredOption("--owner-name <name>", "Label or relationship type name that owns this property")
  .requiredOption("--data-type <type>", `Property data type. One of: ${DATA_TYPES.join(", ")}`)
  .option("--required", "Mark the property as required")
  .option("--description <text>", "Property description")
  .option("--enum-values <values>", "Comma-separated allowed enum values")
  .option("--item-type <type>", "Item type for list properties")
  .option("--example <value>", "Example value")
  .option("--json", "Output raw JSON")
  .action(async (key: string, options: PropUpsertOptions) => {
    requireAuth();
    try {
      const body: Record<string, unknown> = {
        ownerKind: options.ownerKind,
        ownerName: options.ownerName,
        key,
        dataType: options.dataType,
        required: options.required === true,
      };
      if (options.description) body.description = options.description;
      if (options.enumValues) {
        body.enumValues = options.enumValues.split(",").map((s) => s.trim());
      }
      if (options.itemType) body.itemType = options.itemType;
      if (options.example) body.example = options.example;

      const data = await apiRequest("/schema/properties", {
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

export const schemaPropDeleteCommand = new Command("delete")
  .description("Remove a property from the draft")
  .argument("<key>", "Property name/key to delete")
  .requiredOption("--owner-kind <kind>", "Owner kind: node | relationship")
  .requiredOption("--owner-name <name>", "Label or relationship type name that owns the property")
  .option("--json", "Output raw JSON")
  .action(async (key: string, options: PropDeleteOptions) => {
    requireAuth();
    try {
      const data = await apiRequest("/schema/properties", {
        method: "DELETE",
        body: JSON.stringify({ ownerKind: options.ownerKind, ownerName: options.ownerName, key }),
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });

export const schemaPropCommand = new Command("prop")
  .description("Manage schema properties on node labels and relationship types");

schemaPropCommand.addCommand(schemaPropUpsertCommand);
schemaPropCommand.addCommand(schemaPropDeleteCommand);
