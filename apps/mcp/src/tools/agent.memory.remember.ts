import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryRemember } from "@oxagen/oxagen/contracts/agent.memory.remember";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryRemember.input.shape,
  text: agentMemoryRemember.input.shape.text.describe(
    "The lesson to remember, in the user's own words",
  ),
  nodeRef: agentMemoryRemember.input.shape.nodeRef.describe(
    "Graph node id to anchor on; defaults to the user-memory bucket",
  ),
  weight: agentMemoryRemember.input.shape.weight.describe(
    "Pin the salience bucket; omit to let the model infer it",
  ),
  kind: agentMemoryRemember.input.shape.kind.describe(
    "Pin the kind; omit to let the model infer it",
  ),
  source: agentMemoryRemember.input.shape.source.describe(
    "Provenance; defaults to 'user'",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryRemember.name,
  description: agentMemoryRemember.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMemoryRememberTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryRemember.name, args, ctx, { surface: "mcp" });
  return agentMemoryRemember.output.parse(output);
}
