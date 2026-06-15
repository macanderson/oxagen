import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const ontologyNeighborsCommand = new Command("neighbors")
  .description(
    "Return the one-hop neighborhood of a node — directly connected nodes, " +
      "optionally filtered by relationship type and direction.",
  )
  .requiredOption("-n, --node <publicId>", "publicId of the node whose neighbors to fetch")
  .option(
    "-e, --edge-types <types>",
    "Comma-separated relationship types to include (default: all types)",
  )
  .option("-d, --direction <dir>", "Neighbor direction: out | in | both", "both")
  .option("--limit <n>", "Maximum neighbors to return (1–500)", "100")
  .action(async (options: Record<string, unknown>) => {
    try {
      const edgeTypes = options.edgeTypes
        ? String(options.edgeTypes)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

      const result = await apiRequest("/ontology/neighbors", {
        method: "POST",
        body: JSON.stringify({
          nodeId: options.node,
          edgeTypes,
          direction: options.direction,
          limit: Number(options.limit),
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to fetch node neighbors:", error);
      process.exit(1);
    }
  });
