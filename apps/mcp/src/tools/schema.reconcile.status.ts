import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaReconcileStatus } from "@oxagen/oxagen/contracts/schema.reconcile.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...schemaReconcileStatus.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaReconcileStatus.name,
  description: schemaReconcileStatus.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function schemaReconcileStatusTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaReconcileStatus.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(schemaReconcileStatus.output.parse(output));
}
