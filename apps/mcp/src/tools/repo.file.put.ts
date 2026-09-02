import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoFilePut } from "@oxagen/oxagen/contracts/repo.file.put";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoFilePut.input.shape,
  owner: repoFilePut.input.shape.owner.describe(
    "Repository owner (user or organisation)",
  ),
  repo: repoFilePut.input.shape.repo.describe("Repository name"),
  path: repoFilePut.input.shape.path.describe(
    "File path within the repository (e.g. src/index.ts)",
  ),
  content: repoFilePut.input.shape.content.describe(
    "Raw UTF-8 file content — base64 encoding is handled internally",
  ),
  message: repoFilePut.input.shape.message.describe("Commit message"),
  branch: repoFilePut.input.shape.branch.describe(
    "Branch to commit to. Required in practice: the handler rejects (403) a commit " +
      "that targets the repository default branch, and omitting this field would " +
      "silently target it. Create a work branch with create_branch, then land it on " +
      "the default branch with open_pr.",
  ),
};

export const metadata: ToolMetadata = {
  name: repoFilePut.name,
  description:
    "Commits a single file (create or update) to a GitHub repository branch. Prefer over edit_repo_file when the exact file path and content are already known and only a mechanical commit is needed, with no agent reasoning about what to change. Do not use for multi-file, agent-authored edits — use edit_repo_file instead.",
  annotations: {
    readOnlyHint: false,
    // A commit to an existing path overwrites its prior content, so this is a
    // destructive update in MCP terms even though the tool never deletes a file.
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function repoFilePutTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoFilePut.name, args, ctx, { surface: "mcp" });
  return repoFilePut.output.parse(output);
}
