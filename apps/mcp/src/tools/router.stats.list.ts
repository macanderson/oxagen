import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { routerStatsList } from "@oxagen/oxagen/contracts/router.stats.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...routerStatsList.input.shape,
};

export const metadata: ToolMetadata = {
  name: routerStatsList.name,
  description: routerStatsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function routerStatsListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(routerStatsList.name, args, ctx, {
    surface: "mcp",
  });
  return routerStatsList.output.parse(output);
}
