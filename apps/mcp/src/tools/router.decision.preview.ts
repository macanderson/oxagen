import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { routerDecisionPreview } from "@oxagen/oxagen/contracts/router.decision.preview";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...routerDecisionPreview.input.shape,
};

export const metadata: ToolMetadata = {
  name: routerDecisionPreview.name,
  description: routerDecisionPreview.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function routerDecisionPreviewTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(routerDecisionPreview.name, args, ctx, {
    surface: "mcp",
  });
  return routerDecisionPreview.output.parse(output);
}
