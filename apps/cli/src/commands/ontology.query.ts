import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const ontologyQueryCommand = new Command("query")
  .description(
    "Typed multi-hop traversal from a start node over named relationship type(s). " +
      "Returns the reachable subgraph (nodes + edges) without writing Cypher.",
  )
  .requiredOption("-n, --node <publicId>", "publicId of the start node")
  .option(
    "-e, --edge-types <types>",
    "Comma-separated relationship types to follow (default: all types)",
  )
  .option("-d, --direction <dir>", "Traversal direction: out | in | both", "out")
  .option("--max-depth <n>", "Maximum hop distance (1–5)", "2")
  .option("--limit <n>", "Maximum nodes to return (1–500)", "100")
  .action(async (options: Record<string, unknown>) => {
    try {
      const edgeTypes = options.edgeTypes
        ? String(options.edgeTypes)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

      const result = await apiRequest("/ontology/query", {
        method: "POST",
        body: JSON.stringify({
          startNodeId: options.node,
          edgeTypes,
          direction: options.direction,
          maxDepth: Number(options.maxDepth),
          limit: Number(options.limit),
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to run ontology query:", error);
      process.exit(1);
    }
  });
