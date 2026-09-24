import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  githubMainRepoInput,
  workspaceCreate,
} from "@oxagen/oxagen/contracts/workspace.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...workspaceCreate.input.shape,
  name: workspaceCreate.input.shape.name.describe(
    "Display name for the workspace",
  ),
  slug: workspaceCreate.input.shape.slug.describe(
    "URL-safe unique slug within the organization",
  ),
  // The GitHub arm only: the GitLab arm carries a project access token, which
  // must not pass through an MCP client's transcript (#3762).
  mainRepo: githubMainRepoInput.describe(
    "The workspace's main GitHub repository ({ owner, name }), required: a workspace cannot exist without one. The GitHub App must be installed on the owner account and reachable by the organization's connected GitHub account.",
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
  return workspaceCreate.output.parse(output);
}
