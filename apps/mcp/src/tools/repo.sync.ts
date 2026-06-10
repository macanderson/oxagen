import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoSync } from "@oxagen/oxagen/contracts/repo.sync";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoSync.input.shape,
  repoId: repoSync.input.shape.repoId.describe("Repository connection ID"),
  mode: repoSync.input.shape.mode.describe(
    "Sync mode: incremental (since last cursor) or full (re-index from scratch)",
  ),
  recordTypes: repoSync.input.shape.recordTypes.describe(
    "Restrict sync to these record types (omit to sync all)",
  ),
};

export const metadata: ToolMetadata = {
  name: repoSync.name,
  description: repoSync.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function repoSyncTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoSync.name, args, ctx, { surface: "mcp" });
  return repoSync.output.parse(output);
}
