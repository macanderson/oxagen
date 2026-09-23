import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgSsoPolicySet } from "@oxagen/oxagen/contracts/org.sso.policy.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ssoRequired: orgSsoPolicySet.input.shape.ssoRequired.describe(
    "true to require SSO for every member but the Owners, false to stop requiring it",
  ),
};

export const metadata: ToolMetadata = {
  name: orgSsoPolicySet.name,
  description: orgSsoPolicySet.description,
  annotations: {
    readOnlyHint: false,
    // Setting the same value twice leaves the same state.
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgSsoPolicySetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgSsoPolicySet.name, args, ctx, {
    surface: "mcp",
  });
  return orgSsoPolicySet.output.parse(output);
}
