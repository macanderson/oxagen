import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingContractRateGet } from "@oxagen/oxagen/contracts/billing.contract_rate.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: billingContractRateGet.name,
  description: billingContractRateGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingContractRateGetTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingContractRateGet.name, {}, ctx, {
    surface: "mcp",
  });
  return billingContractRateGet.output.parse(output);
}
