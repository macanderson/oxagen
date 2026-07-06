import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoFilePut } from "@oxagen/oxagen/contracts/repo.file.put";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoFilePut.input.shape,
  owner: repoFilePut.input.shape.owner.describe("Repository owner (user or organisation)"),
  repo: repoFilePut.input.shape.repo.describe("Repository name"),
  path: repoFilePut.input.shape.path.describe("File path within the repository (e.g. src/index.ts)"),
  content: repoFilePut.input.shape.content.describe(
    "Raw UTF-8 file content — base64 encoding is handled internally",
  ),
  message: repoFilePut.input.shape.message.describe("Commit message"),
  branch: repoFilePut.input.shape.branch.describe(
    "Branch to commit to (defaults to the repository default branch)",
  ),
};

export const metadata: ToolMetadata = {
  name: repoFilePut.name,
  description:
    "Commits a single file (create or update) to a GitHub repository branch. Prefer over agent.repo.edit when the exact file path and content are already known and only a mechanical commit is needed, with no agent reasoning about what to change. Do not use for multi-file, agent-authored edits — use agent.repo.edit instead.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repoFilePutTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoFilePut.name, args, ctx, { surface: "mcp" });
  return repoFilePut.output.parse(output);
}
