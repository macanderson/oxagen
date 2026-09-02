import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoCiStatus } from "@oxagen/oxagen/contracts/repo.ci.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoCiStatus.input.shape,
  owner: repoCiStatus.input.shape.owner.describe(
    "Repository owner (user or organisation)",
  ),
  repo: repoCiStatus.input.shape.repo.describe("Repository name"),
  ref: repoCiStatus.input.shape.ref.describe(
    "Branch name, commit SHA, or PR head ref to read CI for",
  ),
};

export const metadata: ToolMetadata = {
  name: repoCiStatus.name,
  description:
    "Reads CI status (GitHub Actions check runs plus legacy commit statuses) for a branch, commit SHA, or PR head ref, with an aggregated pass/fail/pending verdict and per-check details.",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repoCiStatusTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoCiStatus.name, args, ctx, { surface: "mcp" });
  return repoCiStatus.output.parse(output);
}
