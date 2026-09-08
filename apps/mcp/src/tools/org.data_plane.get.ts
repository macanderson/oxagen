import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgDataPlaneGet } from "@oxagen/oxagen/contracts/org.data_plane.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...orgDataPlaneGet.input.shape,
  kind: orgDataPlaneGet.input.shape.kind.describe(
    "Which store's binding to read: 'postgres', 'neo4j', or 'clickhouse'",
  ),
};

export const metadata: ToolMetadata = {
  name: orgDataPlaneGet.name,
  description: orgDataPlaneGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgDataPlaneGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgDataPlaneGet.name, args, ctx, {
    surface: "mcp",
  });
  return orgDataPlaneGet.output.parse(output);
}
