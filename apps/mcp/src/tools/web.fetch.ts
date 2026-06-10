import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { webFetch } from "@oxagen/oxagen/contracts/web.fetch";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...webFetch.input.shape,
  url: webFetch.input.shape.url.describe(
    "The URL to fetch. Must use http:// or https:// scheme.",
  ),
  extractMarkdown: webFetch.input.shape.extractMarkdown.describe(
    "When true (default), strip HTML and return clean markdown text. When false, return raw HTML.",
  ),
  timeout: webFetch.input.shape.timeout.describe(
    "Request timeout in milliseconds (1000–30000, default 10000).",
  ),
};

export const metadata: ToolMetadata = {
  name: webFetch.name,
  description: webFetch.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function webFetchTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(webFetch.name, args, ctx, { surface: "mcp" });
  return webFetch.output.parse(output);
}
