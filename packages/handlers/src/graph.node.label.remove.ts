import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeLabelRemove } from "@oxagen/oxagen/contracts/graph.node.label.remove";
import { assertSafeLabel } from "@oxagen/oxagen/contracts/graph.node.label.add";
import { scopedSession } from "@oxagen/ontology/tenant";
import { sanitizeLabel } from "@oxagen/ontology/labels";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

const BASE_LABEL = "GraphNode";

export const graphNodeLabelRemoveHandler: CapabilityHandler<typeof graphNodeLabelRemove> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;
  // Defense-in-depth first: reject non-identifier labels (guards direct callers /
  // injection), then canonicalise to PascalCase so a removal targets the same
  // label add would have applied (billing -> Billing), keeping add/remove symmetric.
  for (const label of input.labels) assertSafeLabel(label);
  const requested = input.labels.map((l) => sanitizeLabel(l) ?? l);
  // Never allow removing the internal base label.
  const toRemove = requested.filter((l) => l !== BASE_LABEL);
  if (toRemove.length === 0) {
    return { nodeId: input.nodeId, labels: [], removed: [] };
  }
  const removeClause = toRemove.map((l) => `\`${l}\``).join(":");

  let labels: string[] = [];
  let removed: string[] = [];

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(
        `MATCH (n:GraphNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
         WITH n, labels(n) AS before
         REMOVE n:${removeClause}
         SET n.updatedAt = datetime()
         RETURN labels(n) AS after, before`,
        { nodeId: input.nodeId },
      );
      const record = result.records[0];
      if (!record) throw new Error(`graph.node.label.remove: node "${input.nodeId}" not found`);
      const after = record.get("after") as string[];
      const before = record.get("before") as string[];
      labels = after.filter((l) => l !== BASE_LABEL);
      removed = toRemove.filter((l) => before.includes(l));
    } finally {
      await session.close();
    }
  });

  logger.info({ nodeId: input.nodeId, removed, orgId, workspaceId }, "graph.node.label.remove");
  return { nodeId: input.nodeId, labels, removed };
};
