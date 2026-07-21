import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { repoConfigure } from "@oxagen/oxagen/contracts/repo.configure";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...repoConfigure.input.shape,
  repoId: repoConfigure.input.shape.repoId.describe(
    "Repository connection ID (UUID or public ID)",
  ),
  recordTypes: repoConfigure.input.shape.recordTypes.describe(
    "Record types to ingest (e.g., pull_request, issue, commit)",
  ),
  pathFilters: repoConfigure.input.shape.pathFilters.describe(
    "Path-based filtering: include/exclude glob patterns",
  ),
  labelFilters: repoConfigure.input.shape.labelFilters.describe(
    "Label-based filtering for issues and PRs",
  ),
  syncCadence: repoConfigure.input.shape.syncCadence.describe(
    "Sync trigger method: manual, polling, or webhook",
  ),
  pollingIntervalSeconds:
    repoConfigure.input.shape.pollingIntervalSeconds.describe(
      "Polling interval in seconds (required when syncCadence=polling)",
    ),
  fieldMappings: repoConfigure.input.shape.fieldMappings.describe(
    "Custom field mappings: source field path → canonical property",
  ),
};

export const metadata: ToolMetadata = {
  name: repoConfigure.name,
  description: repoConfigure.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function repoConfigureTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(repoConfigure.name, args, ctx, {
    surface: "mcp",
  });
  return repoConfigure.output.parse(output);
}
