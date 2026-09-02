import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoFork } from "@oxagen/oxagen/contracts/repo.fork";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoFork.input.shape,
  owner: repoFork.input.shape.owner.describe(
    "Repository owner (user or organisation)",
  ),
  repo: repoFork.input.shape.repo.describe("Repository name"),
  intoOrg: repoFork.input.shape.intoOrg.describe(
    "Fork into this organisation instead of the authenticated user's personal account",
  ),
};

export const metadata: ToolMetadata = {
  name: repoFork.name,
  description:
    "Forks an existing GitHub repository into the caller's account or a target organisation, preserving its history. Prefer over create_repo when work needs to be based on an existing repo's code. Do not use to create a brand-new empty repository — use create_repo instead.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repoForkTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoFork.name, args, ctx, { surface: "mcp" });
  return repoFork.output.parse(output);
}
