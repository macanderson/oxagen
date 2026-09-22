import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { tachoSessionPolicyRead } from "@oxagen/oxagen/contracts/tacho.session_policy.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: tachoSessionPolicyRead.name,
  description: tachoSessionPolicyRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function tachoSessionPolicyReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(tachoSessionPolicyRead.name, {}, ctx, {
    surface: "mcp",
  });
  return tachoSessionPolicyRead.output.parse(output);
}
