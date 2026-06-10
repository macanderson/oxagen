import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const graphCypherCommand = new Command("cypher")
  .description(
    "Execute a Cypher query against the knowledge graph. " +
      "Use --nl for natural-language input (translated to read-only Cypher by an LLM). " +
      "Raw Cypher mode is restricted to privileged roles.",
  )
  .requiredOption("-q, --query <text>", "Cypher query or natural-language description (with --nl)")
  .option("--nl", "Treat --query as natural language and translate to Cypher via LLM", false)
  .option("-p, --params <json>", "JSON object of named parameters to bind into the query")
  .action(async (options: Record<string, unknown>) => {
    try {
      let params: Record<string, string | number | boolean> | undefined;
      if (options.params) {
        try {
          params = JSON.parse(String(options.params)) as Record<
            string,
            string | number | boolean
          >;
        } catch {
          console.error("Error: --params must be valid JSON.");
          process.exit(1);
        }
      }

      const result = await apiRequest("/graph/cypher", {
        method: "POST",
        body: JSON.stringify({
          query: options.query,
          nlQuery: options.nl ?? false,
          params,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to execute Cypher query:", error);
      process.exit(1);
    }
  });
