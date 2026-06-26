import { contracts } from "../../packages/oxagen/src/contracts/index.ts";
import * as fs from "node:fs";

const mcpContracts = new Set(
  contracts.filter((c) => c.surfaces?.includes("mcp")).map((c) => c.name)
);
const toolFiles = fs
  .readdirSync("./apps/mcp/src/tools")
  .filter((f) => f.endsWith(".ts") && !f.includes(".test."));
const toolNames = toolFiles.map((f) => f.replace(".ts", "").replace(/_/g, "."));
const filteredToolNames = new Set(
  toolNames.filter((t) => t !== "index" && t !== "tool-registry")
);

const missingTools = Array.from(mcpContracts)
  .filter((c) => !filteredToolNames.has(c))
  .sort();
const extraTools = Array.from(filteredToolNames)
  .filter((c) => !mcpContracts.has(c))
  .sort();

console.log("MCP contracts total:", mcpContracts.size);
console.log("Tool files total:", filteredToolNames.size);
console.log("\nContracts with 'mcp' surface but NO tool file (" + missingTools.length + "):");
for (const t of missingTools) console.log("  " + t);
console.log("\nTool files with NO matching MCP contract (" + extraTools.length + "):");
for (const t of extraTools) console.log("  " + t);
