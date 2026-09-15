import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { runList } from "@oxagen/oxagen/contracts/run.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...runList.input.shape,
  limit: runList.input.shape.limit.describe("Max runs to return (1–100)"),
  cursor: runList.input.shape.cursor.describe(
    "The nextCursor of an earlier page; omit for the first page",
  ),
};

export const metadata: ToolMetadata = {
  name: runList.name,
  description: runList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function runListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(runList.name, args, ctx, { surface: "mcp" });
  return runList.output.parse(output);
}
