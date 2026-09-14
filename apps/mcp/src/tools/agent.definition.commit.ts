import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentDefinitionCommit } from "@oxagen/oxagen/contracts/agent.definition.commit";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentDefinitionCommit.input.shape,
  agentId: agentDefinitionCommit.input.shape.agentId.describe(
    "The agent's public id (agt_…) or slug",
  ),
  repositoryId: agentDefinitionCommit.input.shape.repositoryId.describe(
    "The repository binding (rpb_…); optional when the workspace binds one repository",
  ),
  branch: agentDefinitionCommit.input.shape.branch.describe(
    "The branch to write; created from the default branch when absent. The default branch is refused.",
  ),
  source: agentDefinitionCommit.input.shape.source.describe(
    'The .oxagen/agents/<slug>.toml text; must declare schema = "agent-definition/v0.1" and the agent\'s slug',
  ),
};

export const metadata: ToolMetadata = {
  name: agentDefinitionCommit.name,
  description: agentDefinitionCommit.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentDefinitionCommitTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentDefinitionCommit.name, args, ctx, {
    surface: "mcp",
  });
  return agentDefinitionCommit.output.parse(output);
}
