import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentCodeExecute } from "@oxagen/oxagen/contracts/agent.code.execute";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentCodeExecute.input.shape,
  language: agentCodeExecute.input.shape.language.describe(
    "Runtime: 'node' (Node.js), 'python' (Python 3), or 'shell' (/bin/sh)",
  ),
  code: agentCodeExecute.input.shape.code.describe(
    "Source code to execute inside the sandbox",
  ),
  timeoutMs: agentCodeExecute.input.shape.timeoutMs.describe(
    "Max execution time in milliseconds (default 30 000, max 300 000)",
  ),
  network: agentCodeExecute.input.shape.network.describe(
    "Network access: 'deny' (default, safe) or 'allow'",
  ),
};

export const metadata: ToolMetadata = {
  name: agentCodeExecute.name,
  description: agentCodeExecute.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function agentCodeExecuteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentCodeExecute.name, args, ctx, {
    surface: "mcp",
  });
  return agentCodeExecute.output.parse(output);
}
