import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeLabelsGet } from "@oxagen/oxagen/contracts/graph.node_label.get";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";

const BASE_LABEL = "GraphNode";

export const graphNodeLabelsGetHandler: CapabilityHandler<
  typeof graphNodeLabelsGet
> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;
  let labels: string[] = [];

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(
        `MATCH (n:GraphNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
         WHERE n.is_system = false
         RETURN labels(n) AS labels`,
        { nodeId: input.nodeId, orgId, workspaceId },
      );
      const record = result.records[0];
      if (!record)
        throw new Error(
          `graph.node.labels.get: node "${input.nodeId}" not found`,
        );
      labels = (record.get("labels") as string[]).filter(
        (l) => l !== BASE_LABEL,
      );
    } finally {
      await session.close();
    }
  });

  return { nodeId: input.nodeId, labels };
};
