// generate-schemas.ts: writes every MCP Studio schema to
// packages/mcp-studio/schemas/<id>.json.
//
//   pnpm exec tsx packages/mcp-studio/scripts/generate-schemas.ts
import { writeSchemaFiles } from "../src/contract/schemas";

for (const path of writeSchemaFiles()) console.log(`wrote ${path}`);
