import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingInvoiceList } from "@oxagen/oxagen/contracts/billing.invoice.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...billingInvoiceList.input.shape,
  limit: billingInvoiceList.input.shape.limit.describe(
    "Max invoices to return (1–100)",
  ),
  cursor: billingInvoiceList.input.shape.cursor.describe(
    "The nextCursor of an earlier page; omit for the first page",
  ),
};

export const metadata: ToolMetadata = {
  name: billingInvoiceList.name,
  description: billingInvoiceList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingInvoiceListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingInvoiceList.name, args, ctx, {
    surface: "mcp",
  });
  return billingInvoiceList.output.parse(output);
}
