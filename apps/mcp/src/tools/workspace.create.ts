import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  githubMainRepoInput,
  workspaceCreate,
} from "@oxagen/oxagen/contracts/workspace.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...workspaceCreate.input.shape,
  name: workspaceCreate.input.shape.name.describe(
    "Display name for the workspace",
  ),
  slug: workspaceCreate.input.shape.slug.describe(
    "URL-safe unique slug within the organization",
  ),
  // Deprecated and ignored (lane S1, #4450). The GitHub arm only: the GitLab
  // arm carries a project access token, which must not pass through an MCP
  // client's transcript (#3762).
  mainRepo: githubMainRepoInput
    .optional()
    .describe(
      "Deprecated and ignored. Leave it out. A workspace no longer takes a main repository: creating one starts provisioning its steering repo, and you link code repositories afterwards with link_repository.",
    ),
};

export const metadata: ToolMetadata = {
  name: workspaceCreate.name,
  description: workspaceCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function workspaceCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceCreate.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(workspaceCreate.output.parse(output));
}
