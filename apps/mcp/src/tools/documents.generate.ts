import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { documentsGenerate } from "@oxagen/oxagen/contracts/documents.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...documentsGenerate.input.shape,
  provider: documentsGenerate.input.shape.provider.describe(
    "Cloud provider to create the document in",
  ),
  kind: documentsGenerate.input.shape.kind.describe(
    "The kind of document to generate",
  ),
  title: documentsGenerate.input.shape.title.describe("Title of the new document"),
  instructions: documentsGenerate.input.shape.instructions.describe(
    "Optional natural-language instructions for content generation",
  ),
  brandKitId: documentsGenerate.input.shape.brandKitId.describe(
    "Optional brand-kit ID to apply to the created file",
  ),
};

export const metadata: ToolMetadata = {
  name: documentsGenerate.name,
  description: documentsGenerate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function documentsGenerateTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(documentsGenerate.name, args, ctx, { surface: "mcp" });
  return documentsGenerate.output.parse(output);
}
