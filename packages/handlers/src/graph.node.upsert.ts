import type { CapabilityHandler } from "@oxagen/oxagen";
import { graphNodeUpsert } from "@oxagen/oxagen/contracts/graph.node.upsert";
import { scopedSession } from "@oxagen/ontology/tenant";
import { sanitizeLabel } from "@oxagen/ontology/labels";
import { runInTenantScope } from "@oxagen/tenancy";
import { embedText } from "@oxagen/ai";
import { logger } from "./logger";

export const graphNodeUpsertHandler: CapabilityHandler<typeof graphNodeUpsert> = async (
  input,
  ctx,
) => {
  const { orgId, workspaceId } = ctx;

  // Natural key is always workspace-scoped: externalId when provided
  // (prefixed with workspaceId so the same external id in two workspaces of the
  // same org does not collide), otherwise label+displayName+workspaceId.
  const naturalKey = input.externalId
    ? `ext:${workspaceId}:${input.externalId}`
    : `${input.label}:${input.displayName}:${workspaceId}`;

  const propertiesJson = input.properties ? JSON.stringify(input.properties) : null;

  // Promote the customer's type to a REAL Neo4j label (in addition to the
  // :GraphNode anchor) so it is queryable/traversable as `(:Submarine)`. Labels
  // cannot be parameterized in Cypher, so the value is sanitized to an
  // injection-safe PascalCase identifier before interpolation; an unusable type
  // (e.g. "!!!") falls back to the anchor-only node with the type preserved in
  // the `label` property. See packages/ontology/src/labels.ts.
  const domainLabel = sanitizeLabel(input.label);
  const domainLabelClause = domainLabel ? `\n           SET n:${domainLabel}` : "";
  // The `label` display property mirrors the structural domain label so the
  // explorer chip reads PascalCase too (PullRequest, not pull_request). When the
  // type is unusable as a label, keep the caller's raw string so the node never
  // loses its human-readable type.
  const displayLabel = domainLabel ?? input.label;

  let nodeId = "";
  let created = false;

  await runInTenantScope({ orgId, workspaceId }, async () => {
    const session = scopedSession();
    try {
      const result = await session.run(
        // MERGE key includes orgId AND workspaceId so a node is uniquely scoped
        // to its workspace; this prevents a same-org sibling workspace from
        // matching (and overwriting) another workspace's node. scopedSession()
        // also auto-injects $orgId/$workspaceId as a safety net, but they are
        // bound explicitly below too (OXA-2062) so this resolver never depends
        // solely on that auto-injection.
        `MERGE (n:GraphNode {naturalKey: $naturalKey, orgId: $orgId, workspaceId: $workspaceId})
         ON CREATE SET
           n.publicId     = randomUUID(),
           n.label        = $label,
           n.displayName  = $displayName,
           n.description  = $description,
           n.properties   = $properties,
           n.is_system    = $isSystem,
           n.createdAt    = datetime(),
           n.updatedAt    = datetime(),
           n._created     = true
         ON MATCH SET
           n.label        = $label,
           n.displayName  = $displayName,
           n.description  = $description,
           n.properties   = $properties,
           n.is_system    = $isSystem,
           n.updatedAt    = datetime(),
           n._created     = false
         WITH n${domainLabelClause}
         RETURN n.publicId AS nodeId, n._created AS wasCreated`,
        {
          naturalKey,
          orgId,
          workspaceId,
          label: displayLabel,
          displayName: input.displayName,
          description: input.description ?? null,
          properties: propertiesJson,
          isSystem: input.isSystem ?? false,
        },
      );

      const record = result.records[0];
      if (!record) {
        throw new Error("graph.node.upsert: MERGE returned no record");
      }

      nodeId = record.get("nodeId") as string;
      created = record.get("wasCreated") as boolean;
    } finally {
      await session.close();
    }
  });

  logger.info(
    { nodeId, created, label: input.label, orgId, workspaceId },
    "graph.node.upsert: node upserted",
  );

  // Best-effort: embed the node text so it's searchable via graph.search.
  // A failed embed must NOT fail the upsert — log and continue.
  try {
    const textParts: string[] = [input.label, input.displayName];
    if (input.description) textParts.push(input.description);
    if (input.properties) {
      for (const v of Object.values(input.properties)) {
        if (v != null && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
          textParts.push(String(v));
        }
      }
    }
    const embeddingText = textParts.join("  ");
    const embedding = await embedText(embeddingText, {
      telemetry: {
        orgId,
        workspaceId,
        surface: "app",
        executionStepId: null,
      },
    });

    await runInTenantScope({ orgId, workspaceId }, async () => {
      const session = scopedSession();
      try {
        await session.run(
          `MATCH (n:GraphNode {publicId: $nodeId, orgId: $orgId})
           SET n.embedding = $embedding, n.embeddingUpdatedAt = datetime()`,
          { nodeId, orgId, embedding },
        );
      } finally {
        await session.close();
      }
    });
  } catch (err) {
    logger.warn({ err, nodeId }, "graph.node.upsert: embedding failed (non-fatal)");
  }

  return { nodeId, created };
};
