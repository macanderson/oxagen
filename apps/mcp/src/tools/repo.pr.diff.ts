import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoPrDiff } from "@oxagen/oxagen/contracts/repo.pr.diff";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoPrDiff.input.shape,
  owner: repoPrDiff.input.shape.owner.describe(
    "Repository owner (user or organisation)",
  ),
  repo: repoPrDiff.input.shape.repo.describe("Repository name"),
  number: repoPrDiff.input.shape.number.describe("Pull request number"),
};

export const metadata: ToolMetadata = {
  name: repoPrDiff.name,
  description:
    "Reads the real per-file unified-diff patches for a pull request, with per-file add/delete counts, rename tracking, and binary-file flags. Read-only — does not modify the PR.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repoPrDiffTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoPrDiff.name, args, ctx, { surface: "mcp" });
  return repoPrDiff.output.parse(output);
}
