import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface FieldDiff {
  name: string;
  current: unknown;
  proposed: unknown;
  changed: boolean;
  reason?: string;
}

interface FormFillResponse {
  fields: FieldDiff[];
}

export const formFillCommand = new Command("fill")
  .description("Generatively fill or suggest values for page form fields based on a natural-language instruction")
  .requiredOption("-r, --route <route>", "URL route the form lives on")
  .requiredOption("-i, --instruction <instruction>", "Natural-language fill instruction")
  .requiredOption("--fields <json>", "Form fields as JSON array: [{name, label, type, current, options?, required?}]")
  .option("--entity <summary>", "Optional summary of the entity being edited")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { route: string; instruction: string; fields: string; entity?: string; org?: string }) => {
    try {
      const fields = JSON.parse(options.fields) as unknown[];
      const data = await apiRequest<FormFillResponse>("/form/fill", {
        method: "POST",
        body: JSON.stringify({
          route: options.route,
          instruction: options.instruction,
          fields,
          entitySummary: options.entity,
          org_id: options.org ?? getOrgId(),
        }),
      });
      const changed = data.fields.filter((f) => f.changed);
      console.log(`✓ Form fill suggestion (${changed.length} field(s) changed)`);
      for (const field of data.fields) {
        const marker = field.changed ? "→" : " ";
        console.log(`  ${marker} ${field.name}: ${JSON.stringify(field.current)} → ${JSON.stringify(field.proposed)}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
