import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface FormCreateResponse {
  form_id: string;
  title: string;
  created_at: string;
}

export const formCreateCommand = new Command("create")
  .description("Create a new form")
  .requiredOption("-t, --title <title>", "Form title")
  .option("-f, --fields <json>", "Form field definitions as JSON")
  .action(async (options: { title: string; fields?: string }) => {
    try {
      let fields: unknown[] = [];
      if (options.fields) {
        try {
          fields = JSON.parse(options.fields);
        } catch {
          throw new Error("Invalid fields JSON");
        }
      }
      console.log(`Creating form "${options.title}"...`);
      const data = await apiRequest<FormCreateResponse>("/form/create", {
        method: "POST",
        body: JSON.stringify({ title: options.title, fields }),
      });
      console.log(`✓ Form created`);
      console.log(`  ID: ${data.form_id}`);
      console.log(`  Title: ${data.title}`);
      console.log(`  Created: ${data.created_at}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
