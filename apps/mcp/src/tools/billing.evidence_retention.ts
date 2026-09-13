import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: billingEvidenceRetention.name,
  description: billingEvidenceRetention.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingEvidenceRetentionTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingEvidenceRetention.name, {}, ctx, {
    surface: "mcp",
  });
  return billingEvidenceRetention.output.parse(output);
}
