import type { CapabilityHandler } from "@oxagen/oxagen";
import { toolDeclarationPublish } from "@oxagen/oxagen/contracts/tool.declaration.publish";
import { publishTool } from "./lib/tool-registry";

/**
 * Publish one hand-authored tool declaration into the workspace registry
 * (origin `declared`, no server). The write itself is `publishTool`
 * (lib/tool-registry.ts), shared with `import_tools`.
 */
export const toolDeclarationPublishHandler: CapabilityHandler<
  typeof toolDeclarationPublish
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new Error(
      "[tool.declaration.publish] workspaceId is required (scoped capability)",
    );
  }
  const published = await publishTool({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId ?? null,
    name: input.name,
    description: input.description,
    inputSchema: input.input_schema,
    readOnly: input.read_only,
    riskGrade: input.risk_grade,
    policyGroup: input.policy_group ?? null,
    manifest: input.manifest,
    source: input.source,
    mcpServerId: null,
    schemaOrigin: "declared",
  });
  return {
    publicId: published.publicId,
    slug: published.slug,
    version: published.version,
    checksum: published.checksum,
    published: published.published,
  };
};
