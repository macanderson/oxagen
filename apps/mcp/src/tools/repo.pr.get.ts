import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoPrGet } from "@oxagen/oxagen/contracts/repo.pr.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoPrGet.input.shape,
  owner: repoPrGet.input.shape.owner.describe(
    "Repository owner (user or organisation)",
  ),
  repo: repoPrGet.input.shape.repo.describe("Repository name"),
  number: repoPrGet.input.shape.number.describe("Pull request number"),
};

export const metadata: ToolMetadata = {
  name: repoPrGet.name,
  description:
    "Reads a pull request's summary, diff stats (additions/deletions/changed files/commits), true comment counts, up to 50 recent comments (newest first), and CI status. Read-only — does not modify the PR.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repoPrGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoPrGet.name, args, ctx, { surface: "mcp" });
  return repoPrGet.output.parse(output);
}
