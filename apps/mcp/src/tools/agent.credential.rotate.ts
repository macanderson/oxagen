import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentCredentialRotate } from "@oxagen/oxagen/contracts/agent.credential.rotate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentCredentialRotate.input.shape,
  agentId: agentCredentialRotate.input.shape.agentId.describe(
    "The agent's public id (agt_…) or slug",
  ),
  validityDays: agentCredentialRotate.input.shape.validityDays.describe(
    "Credential lifetime in days, 1 to 365; default 180",
  ),
};

export const metadata: ToolMetadata = {
  name: agentCredentialRotate.name,
  description: agentCredentialRotate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function agentCredentialRotateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentCredentialRotate.name, args, ctx, {
    surface: "mcp",
  });
  return agentCredentialRotate.output.parse(output);
}
