import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { graphCypher } from "@oxagen/oxagen/contracts/graph.cypher";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...graphCypher.input.shape,
  query: graphCypher.input.shape.query.describe(
    "Either a Cypher query string (nlQuery=false) or a natural-language description of what to retrieve (nlQuery=true)",
  ),
  nlQuery: graphCypher.input.shape.nlQuery.describe(
    "When true, the query is treated as natural language and translated to safe read-only Cypher by an LLM before execution",
  ),
  params: graphCypher.input.shape.params.describe(
    "Named parameters to bind into the Cypher query (e.g. { limit: 10 })",
  ),
};

export const metadata: ToolMetadata = {
  name: graphCypher.name,
  description: graphCypher.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function graphCypherTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(graphCypher.name, args, ctx, { surface: "mcp" });
  return graphCypher.output.parse(output);
}
