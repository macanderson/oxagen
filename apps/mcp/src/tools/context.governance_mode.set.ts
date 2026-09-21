import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { contextGovernanceModeSet } from "@oxagen/oxagen/contracts/context.governance_mode.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  workspaceId: contextGovernanceModeSet.input.shape.workspaceId.describe(
    "The workspace to change (ws_…); omitted, the workspace this call is scoped to",
  ),
  mode: contextGovernanceModeSet.input.shape.mode.describe(
    "solo: any member merges a Context PR. team: an org Owner or Admin, or a workspace Owner, other than the author. regulated: an org Owner or Admin other than the author, recorded as the accountable approver",
  ),
  applyImmediately:
    contextGovernanceModeSet.input.shape.applyImmediately.describe(
      "Commit to the production branch although the mode in force asks for a reviewed pull request. Recorded as steering.governance_overridden",
    ),
};

export const metadata: ToolMetadata = {
  name: contextGovernanceModeSet.name,
  description: contextGovernanceModeSet.description,
  annotations: {
    readOnlyHint: false,
    // It replaces one small file whose every prior value is in git history, and
    // repeating the same call is a no-op (`outcome: "unchanged"`).
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function contextGovernanceModeSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(contextGovernanceModeSet.name, args, ctx, {
    surface: "mcp",
  });
  return contextGovernanceModeSet.output.parse(output);
}
