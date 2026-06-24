import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeLabelAdd, assertSafeLabel } from "@oxagen/oxagen/contracts/graph.node.label.add";
import { scopedSession } from "@oxagen/ontology/tenant";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

// Internal storage label every node carries; not a semantic label, so it is
// hidden from the returned label set.
const BASE_LABEL = "KnowledgeNode";

export const graphNodeLabelAddHandler: CapabilityHandler<typeof graphNodeLabelAdd> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;
  // Defense-in-depth: every label is re-validated before it is interpolated
  // into Cypher, regardless of contract-layer validation.
  for (const label of input.labels) assertSafeLabel(label);
  const setClause = input.labels.map((l) => `\`${l}\``).join(":");

  let labels: string[] = [];
  let added: string[] = [];

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(
        // $orgId / $workspaceId injected by scopedSession(). Labels are NOT
        // parameterizable in Cypher; they are LABEL_PATTERN-guarded above.
        `MATCH (n:KnowledgeNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
         WITH n, labels(n) AS before
         SET n:${setClause}, n.updatedAt = datetime()
         RETURN labels(n) AS after, before`,
        { nodeId: input.nodeId },
      );
      const record = result.records[0];
      if (!record) throw new Error(`graph.node.label.add: node "${input.nodeId}" not found`);
      const after = record.get("after") as string[];
      const before = record.get("before") as string[];
      labels = after.filter((l) => l !== BASE_LABEL);
      added = input.labels.filter((l) => !before.includes(l));
    } finally {
      await session.close();
    }
  });

  logger.info({ nodeId: input.nodeId, added, orgId, workspaceId }, "graph.node.label.add");
  return { nodeId: input.nodeId, labels, added };
};
