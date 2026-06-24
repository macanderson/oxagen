import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

interface SchemaConfigOptions {
  enforcement?: string;
  conformanceFloor?: string;
  json?: boolean;
}

export const schemaConfigCommand = new Command("config")
  .description("Set or view workspace schema registry enforcement mode and conformance floor")
  .option("--enforcement <mode>", "Enforcement mode: strict | lenient | off")
  .option("--conformance-floor <float>", "Conformance floor threshold (0–1)")
  .option("--json", "Output raw JSON")
  .action(async (options: SchemaConfigOptions) => {
    requireAuth();
    try {
      const body: Record<string, unknown> = {};
      if (options.enforcement !== undefined) body.enforcementMode = options.enforcement;
      if (options.conformanceFloor !== undefined) {
        const floor = parseFloat(options.conformanceFloor);
        if (isNaN(floor) || floor < 0 || floor > 1) {
          console.error("Error: --conformance-floor must be a number between 0 and 1.");
          process.exit(1);
        }
        body.conformanceFloor = floor;
      }

      const data = await apiRequest("/schema/registry/config", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
