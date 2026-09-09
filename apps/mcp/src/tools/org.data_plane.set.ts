import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  orgDataPlaneSet,
  orgDataPlaneSetInputObject,
} from "@oxagen/oxagen/contracts/org.data_plane.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Derived from the contract's base object (the refined `input` has no `.shape`).
// invoke() re-parses the full refined contract input, so the mode↔config rules
// are still enforced when the tool is called.
export const schema = {
  ...orgDataPlaneSetInputObject.shape,
  kind: orgDataPlaneSetInputObject.shape.kind.describe(
    "Which store to bind: 'postgres', 'neo4j', or 'clickhouse'",
  ),
  mode: orgDataPlaneSetInputObject.shape.mode.describe(
    "'dedicated' = a customer-controlled endpoint (requires config); 'shared' = return this store to the platform plane (config must be omitted)",
  ),
  config: orgDataPlaneSetInputObject.shape.config.describe(
    "Connection config matching the declared kind — postgres: {host, port, database, username, password, ssl}; neo4j: {uri, username, password, database}; clickhouse: {url, username, password, database}. Envelope-encrypted at rest and never readable back",
  ),
};

export const metadata: ToolMetadata = {
  name: orgDataPlaneSet.name,
  description: orgDataPlaneSet.description,
  annotations: {
    readOnlyHint: false,
    // Rebinding a store moves where the organisation's data is written; the
    // previous binding is replaced, so this is destructive in the MCP sense.
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function orgDataPlaneSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgDataPlaneSet.name, args, ctx, {
    surface: "mcp",
  });
  return orgDataPlaneSet.output.parse(output);
}
