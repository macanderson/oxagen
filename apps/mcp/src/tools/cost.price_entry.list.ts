import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { costPriceEntryList } from "@oxagen/oxagen/contracts/cost.price_entry.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...costPriceEntryList.input.shape,
  at: costPriceEntryList.input.shape.at.describe(
    "RFC 3339 instant the entries must be effective at; omit for now",
  ),
};

export const metadata: ToolMetadata = {
  name: costPriceEntryList.name,
  description: costPriceEntryList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function costPriceEntryListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(costPriceEntryList.name, args, ctx, {
    surface: "mcp",
  });
  return costPriceEntryList.output.parse(output);
}
