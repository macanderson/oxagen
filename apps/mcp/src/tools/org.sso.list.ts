import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgSsoList } from "@oxagen/oxagen/contracts/org.sso.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// The contract takes no input: the providers are the caller's organisation's.
export const schema = {
  ...orgSsoList.input.shape,
};

export const metadata: ToolMetadata = {
  name: orgSsoList.name,
  description: orgSsoList.description,
  annotations: {
    readOnlyHint: true,
    // A read. Secrets are reported as set or not set, never returned.
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgSsoListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgSsoList.name, args, ctx, { surface: "mcp" });
  return orgSsoList.output.parse(output);
}
