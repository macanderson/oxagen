import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  costCenterSet,
  costCenterSetInputObject,
} from "@oxagen/oxagen/contracts/cost_center.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// Built from the contract's base object (the refined `input` has no `.shape`).
// invoke() parses the refined input, so an agent target still has to name
// the agent here.
export const schema = {
  ...costCenterSetInputObject.shape,
  target: costCenterSetInputObject.shape.target.describe(
    "What to label: 'workspace' for a workspace, 'agent' for one agent in the active workspace",
  ),
  workspaceId: costCenterSetInputObject.shape.workspaceId.describe(
    "The workspace's public id (wrk_…) when target is 'workspace'. Omit it for the active workspace",
  ),
  agent: costCenterSetInputObject.shape.agent.describe(
    "The agent's slug in this workspace. Required when target is 'agent'",
  ),
  costCenter: costCenterSetInputObject.shape.costCenter.describe(
    "A label on the organization's cost-center list, or null to clear it",
  ),
};

export const metadata: ToolMetadata = {
  name: costCenterSet.name,
  description: costCenterSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function costCenterSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(costCenterSet.name, args, ctx, {
    surface: "mcp",
  });
  return costCenterSet.output.parse(output);
}
