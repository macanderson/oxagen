import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { findingEvidenceGet } from "@oxagen/oxagen/contracts/finding.evidence.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  findingId: findingEvidenceGet.input.shape.findingId.describe(
    "The finding's public id (fnd_…), as list_findings reports it",
  ),
};

export const metadata: ToolMetadata = {
  name: findingEvidenceGet.name,
  description: findingEvidenceGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function findingEvidenceGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const input = findingEvidenceGet.input.parse(args);
  const output = await invoke(findingEvidenceGet.name, input, ctx, {
    surface: "mcp",
  });
  return findingEvidenceGet.output.parse(output);
}
