import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentRegister } from "@oxagen/oxagen/contracts/agent.register";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentRegister.input.shape,
  slug: agentRegister.input.shape.slug.describe(
    "Lowercase words joined by hyphens; the definition file name and the last segment of the agent key",
  ),
  validityDays: agentRegister.input.shape.validityDays.describe(
    "Credential lifetime in days, 1 to 365; default 180",
  ),
};

export const metadata: ToolMetadata = {
  name: agentRegister.name,
  description: agentRegister.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentRegisterTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentRegister.name, args, ctx, {
    surface: "mcp",
  });
  return agentRegister.output.parse(output);
}
