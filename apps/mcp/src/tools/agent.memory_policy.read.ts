import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryPolicyRead } from "@oxagen/oxagen/contracts/agent.memory_policy.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = agentMemoryPolicyRead.input.shape;

export const metadata: ToolMetadata = {
  name: agentMemoryPolicyRead.name,
  description: agentMemoryPolicyRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryPolicyReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryPolicyRead.name, {}, ctx, {
    surface: "mcp",
  });
  return agentMemoryPolicyRead.output.parse(output);
}
