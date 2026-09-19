import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { costPriceEntryRemove } from "@oxagen/oxagen/contracts/cost.price_entry.remove";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...costPriceEntryRemove.input.shape,
  provider: costPriceEntryRemove.input.shape.provider.describe(
    "The provider the model is billed through, e.g. anthropic",
  ),
  model: costPriceEntryRemove.input.shape.model.describe(
    "The canonical model id the negotiated row prices, e.g. claude-sonnet-5",
  ),
  tokenClass: costPriceEntryRemove.input.shape.tokenClass.describe(
    "Which class of units to return to list pricing, e.g. output",
  ),
  at: costPriceEntryRemove.input.shape.at.describe(
    "RFC 3339 instant the negotiated rate stops applying; omit for now",
  ),
  acknowledgeUnpriced:
    costPriceEntryRemove.input.shape.acknowledgeUnpriced.describe(
      "End the rate even though no list price or override can price this model and class, leaving it unpriced so its runs record no cost. Omit to have that removal refused instead",
    ),
};

export const metadata: ToolMetadata = {
  name: costPriceEntryRemove.name,
  description: costPriceEntryRemove.description,
  annotations: {
    readOnlyHint: false,
    // Nothing is deleted: the row is closed at an instant and kept, so a run
    // priced before it still resolves the entry it was priced with.
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function costPriceEntryRemoveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(costPriceEntryRemove.name, args, ctx, {
    surface: "mcp",
  });
  return costPriceEntryRemove.output.parse(output);
}
