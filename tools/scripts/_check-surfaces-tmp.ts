import { contracts } from "../../packages/oxagen/src/contracts/index.ts";

const check = ["plugin.catalog.sync", "skill.create", "skill.enable"];
for (const n of check) {
  const c = contracts.find((x) => x.name === n);
  if (c) console.log(n + " -> surfaces: " + JSON.stringify(c.surfaces));
  else console.log(n + " -> NOT FOUND");
}

// Also get the full set of MCP tool names from tool-registry test (by reading files)
import * as fs from "node:fs";
const testContent = fs.readFileSync("./apps/mcp/src/tools/tool-registry.test.ts", "utf-8");
// Count metadata imports in the test
const metadataImports = testContent.match(/import \{ metadata as \w+/g);
console.log("\nTool-registry test metadata imports: " + (metadataImports?.length ?? 0));

// Count entries in allToolMetadata array
const arrayMatch = testContent.match(/const allToolMetadata = \[([\s\S]*?)\];/);
if (arrayMatch) {
  const entries = arrayMatch[1]!.split(",").filter(l => l.trim().length > 0);
  console.log("allToolMetadata entries: " + entries.length);
}

const mcpCount = contracts.filter((c) => c.surfaces?.includes("mcp")).length;
console.log("Contracts with MCP surface: " + mcpCount);
