import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { codePatch } from "@oxagen/oxagen/contracts/code.patch";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...codePatch.input.shape,
};

export const metadata: ToolMetadata = {
  name: codePatch.name,
  description: codePatch.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function codePatchTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(codePatch.name, args, ctx, { surface: "mcp" });
  return codePatch.output.parse(output);
}
