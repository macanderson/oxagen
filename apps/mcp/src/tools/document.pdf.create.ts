import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { documentsPdfCreate } from "@oxagen/oxagen/contracts/document.pdf.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Generate a PDF from a title and structured text content using pdf-lib.
// Pure JS, no Chromium required, serverless-safe.

export const schema = {
  ...documentsPdfCreate.input.shape,
  title: documentsPdfCreate.input.shape.title.describe(
    "Title / filename of the output PDF",
  ),
  content: documentsPdfCreate.input.shape.content.describe(
    "Structured content sections (heading + paragraphs) to render into the PDF",
  ),
  brandColors: documentsPdfCreate.input.shape.brandColors.describe(
    "Optional brand colors (primary, secondary) for the PDF",
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

export default async function documentsPdfCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(documentsPdfCreate.name, args, ctx, {
    surface: "mcp",
  });
  return documentsPdfCreate.output.parse(output);
}
