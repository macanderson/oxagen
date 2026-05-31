import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { documentsGenerate } from "@oxagen/oxagen/contracts/documents.generate";
import { documentsGenerateHandler } from "@oxagen/handlers/documents.generate";
import { buildContext } from "../context.js";

export const schema = {
  provider: z.enum(["google", "microsoft"]).describe("Cloud provider to create the document in"),
  kind: z
    .enum(["document", "spreadsheet", "presentation"])
    .describe("The kind of document to generate"),
  title: z.string().min(1).describe("Title of the new document"),
  instructions: z
    .string()
    .optional()
    .describe("Optional natural-language instructions for content generation"),
  brandKitId: z
    .string()
    .optional()
    .describe("Optional brand-kit ID to apply to the created file"),
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
  const output = await documentsGenerateHandler(args, ctx);
  return documentsGenerate.output.parse(output);
}
