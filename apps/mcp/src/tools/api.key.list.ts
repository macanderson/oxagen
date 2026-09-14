import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...apiKeyList.input.shape,
};

export const metadata: ToolMetadata = {
  name: apiKeyList.name,
  description: apiKeyList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function apiKeyListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(apiKeyList.name, args, ctx, { surface: "mcp" });
  return apiKeyList.output.parse(output);
}
