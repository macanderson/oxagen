import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface FormSubmitResponse {
  submission_id: string;
  status: string;
  created_at: string;
}

export const formSubmitCommand = new Command("submit")
  .description("Submit a response to a form")
  .requiredOption("-f, --form <id>", "Form ID to submit to")
  .option("-r, --responses <json>", "Form responses as JSON")
  .action(async (options: { form: string; responses?: string }) => {
    try {
      let responses: Record<string, unknown> = {};
      if (options.responses) {
        try {
          responses = JSON.parse(options.responses) as Record<string, unknown>;
        } catch {
          throw new Error("Invalid responses JSON");
        }
      }
      console.log(`Submitting form ${options.form}...`);
      const data = await apiRequest<FormSubmitResponse>("/form/submit", {
        method: "POST",
        body: JSON.stringify({ form_id: options.form, responses }),
      });
      console.log(`✓ Form submitted`);
      console.log(`  Submission ID: ${data.submission_id}`);
      console.log(`  Status: ${data.status}`);
      console.log(`  Created: ${data.created_at}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
