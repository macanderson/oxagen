import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSandboxStart } from "@oxagen/oxagen/contracts/agent.sandbox.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSandboxStart.input.shape,
  sessionKey: agentSandboxStart.input.shape.sessionKey.describe(
    "Stable key (e.g. conversation or agent-run id) to reuse one durable sandbox across turns; omit to always provision fresh",
  ),
  image: agentSandboxStart.input.shape.image.describe(
    "Base image: 'agent' (Debian + git + curl, default for repo workflows), 'node', 'python', or 'shell'",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSandboxStart.name,
  description: agentSandboxStart.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentSandboxStartTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSandboxStart.name, args, ctx, {
    surface: "mcp",
  });
  return agentSandboxStart.output.parse(output);
}
