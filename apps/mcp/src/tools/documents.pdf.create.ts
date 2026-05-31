import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { documentsPdfCreate } from "@oxagen/oxagen/contracts/documents.pdf.create";
import { documentsPdfCreateHandler } from "@oxagen/handlers/documents.pdf.create";
import { buildContext } from "../context.js";

export const schema = {
  title: z.string().min(1).describe("Title / filename of the output PDF"),
  sourceHtml: z.string().optional().describe("Raw HTML markup to render into a PDF"),
  sourceFileId: z
    .string()
    .optional()
    .describe("Cloud file ID of a document to export as PDF"),
  brandKitId: z
    .string()
    .optional()
    .describe("Optional brand-kit ID to apply to the PDF output"),
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
  const output = await documentsPdfCreateHandler(args, ctx);
  return documentsPdfCreate.output.parse(output);
}
