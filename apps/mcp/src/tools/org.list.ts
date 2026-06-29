import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...orgList.input.shape,
};

export const metadata: ToolMetadata = {
  name: orgList.name,
  description: orgList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function orgListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(orgList.name, args, ctx, { surface: "mcp" });
  return orgList.output.parse(output);
}
