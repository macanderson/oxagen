import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { costPriceEntrySet } from "@oxagen/oxagen/contracts/cost.price_entry.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...costPriceEntrySet.input.shape,
  provider: costPriceEntrySet.input.shape.provider.describe(
    "The provider the model is billed through, e.g. anthropic",
  ),
  model: costPriceEntrySet.input.shape.model.describe(
    "The canonical model id the frame reports, e.g. claude-sonnet-5",
  ),
  tokenClass: costPriceEntrySet.input.shape.tokenClass.describe(
    "Which class of units this rate prices, e.g. input_uncached or output",
  ),
  usdPerMillion: costPriceEntrySet.input.shape.usdPerMillion.describe(
    "The contracted price in USD per one million units, as the contract reads it (2.40, not 2400000)",
  ),
  effectiveFrom: costPriceEntrySet.input.shape.effectiveFrom.describe(
    "RFC 3339 instant the rate starts applying; omit for now. Never earlier than the rate it replaces. State it explicitly and reuse it to make a retry safe: each call that omits it starts a new window",
  ),
};

export const metadata: ToolMetadata = {
  name: costPriceEntrySet.name,
  description: costPriceEntrySet.description,
  annotations: {
    readOnlyHint: false,
    // The superseded row is closed, not overwritten.
    destructiveHint: false,
    // NOT idempotent as advertised to a caller: the write is idempotent on its
    // row key, but the key includes `effectiveFrom`, and a call that omits it
    // takes the write instant. A retry after a lost response therefore opens
    // ANOTHER window — closes the row the first call wrote and inserts a new
    // one — rather than repeating the same operation. A caller that wants a
    // safe retry states `effectiveFrom` itself, once, and reuses it.
    idempotentHint: false,
  },
};

export default async function costPriceEntrySetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(costPriceEntrySet.name, args, ctx, {
    surface: "mcp",
  });
  return costPriceEntrySet.output.parse(output);
}
