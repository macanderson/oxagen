import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { codeFormat } from "@oxagen/oxagen/contracts/code.format";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...codeFormat.input.shape,
};

export const metadata: ToolMetadata = {
  name: codeFormat.name,
  description: codeFormat.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function codeFormatTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(codeFormat.name, args, ctx, { surface: "mcp" });
  return codeFormat.output.parse(output);
}
