import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { revisionDiffGet } from "@oxagen/oxagen/contracts/forge.revision.diff.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...revisionDiffGet.input.shape };

export const metadata: ToolMetadata = {
  name: revisionDiffGet.name,
  description: revisionDiffGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function revisionDiffGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(revisionDiffGet.name, args, ctx, {
    surface: "mcp",
  });
  return revisionDiffGet.output.parse(output);
}
