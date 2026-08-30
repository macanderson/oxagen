import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { documentsGenerate } from "@oxagen/oxagen/contracts/document.generate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Generate a DOCX document, XLSX spreadsheet, or PPTX presentation from
// structured content. No cloud OAuth required — built in-process.

export const schema = {
  ...documentsGenerate.input.shape,
  kind: documentsGenerate.input.shape.kind.describe(
    "The file format to generate: document (DOCX), spreadsheet (XLSX), or presentation (PPTX)",
  ),
  title: documentsGenerate.input.shape.title.describe(
    "Title of the document / spreadsheet / presentation",
  ),
  content: documentsGenerate.input.shape.content.describe(
    "Structured content: sections (document), headers+rows (spreadsheet), or slides (presentation)",
  ),
  brandColors: documentsGenerate.input.shape.brandColors.describe(
    "Optional brand colors (primary, secondary) to thread through the document",
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

export default async function documentsGenerateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(documentsGenerate.name, args, ctx, {
    surface: "mcp",
  });
  return documentsGenerate.output.parse(output);
}
