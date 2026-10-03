import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workCriterionClaim } from "@oxagen/oxagen/contracts/work.criterion.claim";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...workCriterionClaim.input.shape };

export const metadata: ToolMetadata = {
  name: workCriterionClaim.name,
  description: workCriterionClaim.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function claimWorkCriterionTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(workCriterionClaim.name, args, ctx, {
    surface: "mcp",
  });
  return workCriterionClaim.output.parse(output);
}
