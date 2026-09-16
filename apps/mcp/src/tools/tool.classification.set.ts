import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolClassificationSet } from "@oxagen/oxagen/contracts/tool.classification.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...toolClassificationSet.input.shape,
  toolVersionId: toolClassificationSet.input.shape.toolVersionId.describe(
    "The tlv_… version to classify",
  ),
  riskGrade: toolClassificationSet.input.shape.riskGrade.describe(
    "Risk grade: low, medium, high or critical",
  ),
  classification: toolClassificationSet.input.shape.classification.describe(
    "Side-effect class, egress class, consequence tags, measures (paths into the input) and data classes",
  ),
  reason: toolClassificationSet.input.shape.reason.describe(
    "Why the version is classified this way; recorded on the version",
  ),
};

export const metadata: ToolMetadata = {
  name: toolClassificationSet.name,
  description: toolClassificationSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function toolClassificationSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolClassificationSet.name, args, ctx, {
    surface: "mcp",
  });
  return toolClassificationSet.output.parse(output);
}
