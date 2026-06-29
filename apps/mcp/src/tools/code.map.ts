import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { codeMap } from "@oxagen/oxagen/contracts/code.map";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...codeMap.input.shape,
  query: codeMap.input.shape.query.describe(
    "Natural-language concept query — e.g. 'payments', 'auth session handling'. " +
      "Returns files, symbols, call edges, and recent commits related to the concept.",
  ),
  limit: codeMap.input.shape.limit.describe(
    "Maximum number of source files to return (1–50, default 20)",
  ),
  kinds: codeMap.input.shape.kinds.describe(
    "Which result kinds to populate: file, symbol, chunk, commit. Omit for all.",
  ),
  domain: codeMap.input.shape.domain.describe(
    "Optional domain filter — only return nodes whose domain property matches (e.g. 'billing').",
  ),
};

export const metadata: ToolMetadata = {
  name: codeMap.name,
  description: codeMap.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function codeMapTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(codeMap.name, args, ctx, { surface: "mcp" });
  return codeMap.output.parse(output);
}
