import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { documentsPdfCreate } from "@oxagen/oxagen/contracts/documents.pdf.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...documentsPdfCreate.input.shape,
  title: documentsPdfCreate.input.shape.title.describe(
    "Title / filename of the output PDF",
  ),
  sourceHtml: documentsPdfCreate.input.shape.sourceHtml.describe(
    "Raw HTML markup to render into a PDF",
  ),
  sourceFileId: documentsPdfCreate.input.shape.sourceFileId.describe(
    "Cloud file ID of a document to export as PDF",
  ),
  brandKitId: documentsPdfCreate.input.shape.brandKitId.describe(
    "Optional brand-kit ID to apply to the PDF output",
  ),
};

export const metadata: ToolMetadata = {
  name: documentsPdfCreate.name,
  description: documentsPdfCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function documentsPdfCreateTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(documentsPdfCreate.name, args, ctx, { surface: "mcp" });
  return documentsPdfCreate.output.parse(output);
}
