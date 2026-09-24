import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingPrepaidOrderList } from "@oxagen/oxagen/contracts/billing.prepaid_order.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...billingPrepaidOrderList.input.shape,
  limit: billingPrepaidOrderList.input.shape.limit.describe(
    "Max prepaid orders to return (1 to 100)",
  ),
  cursor: billingPrepaidOrderList.input.shape.cursor.describe(
    "The nextCursor of an earlier page; omit for the first page",
  ),
};

export const metadata: ToolMetadata = {
  name: billingPrepaidOrderList.name,
  description: billingPrepaidOrderList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingPrepaidOrderListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingPrepaidOrderList.name, args, ctx, {
    surface: "mcp",
  });
  return billingPrepaidOrderList.output.parse(output);
}
