import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { schemaReconcileDispatch } from "@oxagen/oxagen/contracts/schema.reconcile.dispatch";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...schemaReconcileDispatch.input.shape,
};

export const metadata: ToolMetadata = {
  name: schemaReconcileDispatch.name,
  description: schemaReconcileDispatch.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function schemaReconcileDispatchTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(schemaReconcileDispatch.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(schemaReconcileDispatch.output.parse(output));
}
