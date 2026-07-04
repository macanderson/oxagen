import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { a2aCardGet } from "@oxagen/oxagen/contracts/a2a.card.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...a2aCardGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: a2aCardGet.name,
  description: a2aCardGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function a2aCardGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(a2aCardGet.name, args, ctx, { surface: "mcp" });
  return a2aCardGet.output.parse(output);
}
