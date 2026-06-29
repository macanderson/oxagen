import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeLabelAdd, assertSafeLabel } from "@oxagen/oxagen/contracts/graph.node.label.add";
import { scopedSession } from "@oxagen/ontology/tenant";
import { sanitizeLabel } from "@oxagen/ontology/labels";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "./logger";

// Internal storage label every node carries; not a semantic label, so it is
// hidden from the returned label set.
const BASE_LABEL = "GraphNode";

export const graphNodeLabelAddHandler: CapabilityHandler<typeof graphNodeLabelAdd> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;
  // Defense-in-depth: reject any non-identifier label BEFORE processing (the
  // contract already enforces LABEL_PATTERN; this guards direct handler callers
  // and any injection attempt). Run first so garbage throws rather than being
  // silently coerced.
  for (const label of input.labels) assertSafeLabel(label);
  // Canonicalise the validated labels to the graph-wide PascalCase convention
  // (billing -> Billing) so this primitive never introduces an off-convention
  // label. A LABEL_PATTERN-valid label always sanitizes to a non-null identifier.
  const requested = input.labels.map((l) => sanitizeLabel(l) ?? l);
  const setClause = requested.map((l) => `\`${l}\``).join(":");

  let labels: string[] = [];
  let added: string[] = [];

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(
        // $orgId / $workspaceId injected by scopedSession(). Labels are NOT
        // parameterizable in Cypher; they are LABEL_PATTERN-guarded above.
        `MATCH (n:GraphNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
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
      added = requested.filter((l) => !before.includes(l));
    } finally {
      await session.close();
    }
  });

  logger.info({ nodeId: input.nodeId, added, orgId, workspaceId }, "graph.node.label.add");
  return { nodeId: input.nodeId, labels, added };
};
