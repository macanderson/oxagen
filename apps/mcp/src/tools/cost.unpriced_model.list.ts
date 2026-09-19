import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { costUnpricedModelList } from "@oxagen/oxagen/contracts/cost.unpriced_model.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...costUnpricedModelList.input.shape,
  since: costUnpricedModelList.input.shape.since.describe(
    "RFC 3339 instant to count model calls from; omit for the last 30 days",
  ),
  at: costUnpricedModelList.input.shape.at.describe(
    "RFC 3339 instant the price book must be effective at; omit for now",
  ),
};

export const metadata: ToolMetadata = {
  name: costUnpricedModelList.name,
  description: costUnpricedModelList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function costUnpricedModelListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(costUnpricedModelList.name, args, ctx, {
    surface: "mcp",
  });
  return costUnpricedModelList.output.parse(output);
}
