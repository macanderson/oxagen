 
import { z } from "zod";
import { createFunction } from "../create-function";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { sanitizeRelationshipType, sanitizeLabel } from "@oxagen/ontology/labels";
import { generateObjectFor } from "@oxagen/ai";
import { logger } from "../logger";

/**
 * Default system prompt instructing the LLM on how to extract cross-entity
 * relationships from a single entity's property bag. Connectors may override
 * this via their schema's `semanticInference.ontologyPrompt` field.
 */
const DEFAULT_SYSTEM_PROMPT =
  "You are a knowledge-graph architect. Given a JSON object representing a business entity, " +
  "identify meaningful relationships it implies with other entities in the knowledge graph. " +
  "For each relationship output: the target entity type (e.g. Feature, Service, Person, Team), " +
  "the target entity name, the relationship type in UPPER_SNAKE_CASE (e.g. IMPLEMENTS, BELONGS_TO, " +
  "ASSIGNED_TO, REFERENCES, DEPENDS_ON), and a confidence score 0.0–1.0. " +
  "Only emit relationships you are confident about. Be conservative — prefer fewer, higher-quality edges.";

const edgeInferenceSchema = z.object({
  edges: z
    .array(
      z.object({
        targetType: z
          .string()
          .describe("Label of the target entity (e.g. Feature, Service, Person)"),
        targetName: z
          .string()
          .describe("Display name or identifier of the target entity"),
        relationshipType: z
          .string()
          .describe("Relationship type in UPPER_SNAKE_CASE (e.g. IMPLEMENTS, BELONGS_TO)"),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe("Confidence score 0.0–1.0"),
      }),
    )
    .max(20),
});

/**
 * Inngest function that handles `ingestion/entity.infer`.
 *
 * Fired by the 6-step ingestion pipeline (step 6) once an EntityNode has been
 * embedded. For each entity:
 *   1. Fetch the ontology prompt from the connector schema (or use default).
 *   2. Call the LLM via @oxagen/ai with the entity's property snapshot.
 *   3. Write InferredEdge nodes to Neo4j with approvalStatus = "pending".
 *      Edges at or above a 0.85 auto-accept threshold are written as
 *      "approved" and immediately materialised as permanent relationships typed
 *      by the inferred relationship kind itself (e.g. :IMPLEMENTS, :BELONGS_TO),
 *      with `inferred: true` / `origin: "semantic"` properties marking provenance.
 *
 * Concurrency is limited to 8 parallel inferences per org to avoid thundering
 * herd against the AI Gateway after a large batch sync.
 */
export const [ingestionSemanticEdgeInfer] = createFunction(
  {
    id: "ingestion-semantic-edge-infer",
    retries: 2,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "ingestion/entity.infer" },
  async ({ event, step }) => {
    const { nodeId, entityType, propertiesSnapshot, workspaceId, orgId } = event.data as {
      nodeId: string;
      entityType: string;
      propertiesSnapshot: Record<string, unknown>;
      workspaceId: string;
      orgId: string;
    };

    // ── Step 1: Infer edges via LLM ──────────────────────────────────────────
    const inferResult = await step.run("infer-edges", () =>
      generateObjectFor({
        schema: edgeInferenceSchema,
        system: DEFAULT_SYSTEM_PROMPT,
        prompt:
          `Entity type: ${entityType}\n` +
          `Properties: ${JSON.stringify(propertiesSnapshot, null, 2)}`,
        telemetry: {
          orgId,
          workspaceId,
          surface: "ingestion",
          // No initiating message for ingestion-time semantic-edge inference.
          // Must be a UUID or null — `semantic-edge-infer:<nodeId>` flooded
          // token_usage's UUID column and broke the uuid credit charge.
          messageId: null,
        },
        // Edge inference is deterministic in an entity's property snapshot:
        // two entities with the same properties imply the same edges. Cache it
        // (semantic on) so a re-sync of unchanged entities, or two structurally
        // identical entities, reuse a recent inference instead of re-spending.
        // 7-day TTL — ontology inference is stable over that window.
        cache: { ttlSeconds: 604_800, semantic: true },
      }),
    );

    const edges = inferResult.object.edges;
    const AUTO_ACCEPT_THRESHOLD = 0.85;

    logger.info(
      {
        nodeId,
        entityType,
        orgId,
        totalEdges: edges.length,
        autoAccepted: edges.filter((e) => e.confidence >= AUTO_ACCEPT_THRESHOLD).length,
        pending: edges.filter((e) => e.confidence < AUTO_ACCEPT_THRESHOLD).length,
      },
      "ingestion-semantic-edge-infer: inference complete",
    );

    if (edges.length === 0) {
      return { nodeId, edgesCreated: 0, autoAccepted: 0 };
    }

    // ── Step 2: Write InferredEdge nodes + materialise auto-accepted edges ───
    const result = await step.run("write-inferred-edges", () =>
      runInTenantScope({ orgId, workspaceId }, async () => {
        const sess = scopedSession();
        let pendingCount = 0;
        let autoAcceptedCount = 0;

        try {
          const now = new Date().toISOString();
          const model = `ingestion-semantic-edge-infer`;
          const promptText = `Entity type: ${entityType}\nProperties: ${JSON.stringify(propertiesSnapshot)}`;

          for (const edge of edges) {
            const edgeId = crypto.randomUUID();
            const isAutoAccepted = edge.confidence >= AUTO_ACCEPT_THRESHOLD;
            const approvalStatus = isAutoAccepted ? "approved" : "pending";

            // Create the InferredEdge node (idempotent: MERGE on sourceNodeId+targetType+targetName+relType)
            await sess.run(
              `MERGE (ie:InferredEdge {
                 orgId: $orgId,
                 sourceNodeId: $sourceNodeId,
                 targetType: $targetType,
                 targetName: $targetName,
                 relationshipType: $relationshipType
               })
               ON CREATE SET
                 ie.id              = $id,
                 ie.workspaceId     = $workspaceId,
                 ie.connectionId    = $connectionId,
                 ie.confidence      = $confidence,
                 ie.approvalStatus  = $approvalStatus,
                 ie.approvedBy      = $approvedBy,
                 ie.approvedAt      = $approvedAt,
                 ie.llmModel        = $llmModel,
                 ie.semanticPrompt  = $semanticPrompt,
                 ie.inferredAt      = datetime($inferredAt)
               ON MATCH SET
                 ie.confidence      = $confidence,
                 ie.approvalStatus  = CASE WHEN ie.approvalStatus = 'pending' THEN $approvalStatus ELSE ie.approvalStatus END,
                 ie.llmModel        = $llmModel,
                 ie.semanticPrompt  = $semanticPrompt,
                 ie.inferredAt      = datetime($inferredAt)`,
              {
                orgId,
                workspaceId,
                sourceNodeId: nodeId,
                targetType: edge.targetType,
                targetName: edge.targetName,
                relationshipType: edge.relationshipType,
                id: edgeId,
                connectionId: propertiesSnapshot["connectionId"] as string ?? "",
                confidence: edge.confidence,
                approvalStatus,
                approvedBy: isAutoAccepted ? "system:auto-accept" : null,
                approvedAt: isAutoAccepted ? now : null,
                llmModel: model,
                semanticPrompt: promptText,
                inferredAt: now,
              },
            );

            if (isAutoAccepted) {
              // Materialise a permanent relationship typed by the inferred kind
              // itself (e.g. :IMPLEMENTS, :BELONGS_TO) so the graph reads
              // descriptively — never a generic :SEMANTIC_EDGE. The inferred
              // origin is carried on `r.inferred` / `r.origin`, and `r.confidence`
              // (< 1.0 here) further distinguishes auto-accepted edges from
              // human-authored ones. Relationship types cannot be parameterized in
              // Cypher, so sanitize + interpolate. Find or create the target
              // placeholder node, then create the relationship.
              const relType = sanitizeRelationshipType(edge.relationshipType);
              // The materialised target carries a DESCRIPTIVE PascalCase domain
              // label (e.g. :Feature, :Service) so an auto-accepted inferred node
              // reads like any other graph node — never an anchor-only :GraphNode.
              // sanitizeLabel makes it injection-safe; applied idempotently so it
              // also lands on pre-existing placeholders. `tgt.label` mirrors it.
              const tgtDomainLabel = sanitizeLabel(edge.targetType);
              const tgtLabelClause = tgtDomainLabel
                ? `SET tgt:${tgtDomainLabel}\n                 WITH src, tgt\n                 `
                : "";
              await sess.run(
                `MATCH (src:EntityNode {publicId: $sourceNodeId, orgId: $orgId})
                 MERGE (tgt:GraphNode {
                   orgId: $orgId,
                   workspaceId: $workspaceId,
                   type: $targetType,
                   name: $targetName
                 })
                 ON CREATE SET
                   tgt.id          = randomUUID(),
                   tgt.publicId    = randomUUID(),
                   tgt.label       = $targetDisplayLabel,
                   tgt.displayName = $targetName,
                   tgt.createdAt   = datetime()
                 SET
                   tgt.label       = coalesce(tgt.label, $targetDisplayLabel),
                   tgt.displayName = coalesce(tgt.displayName, $targetName)
                 WITH src, tgt
                 ${tgtLabelClause}MERGE (src)-[r:${relType} {inferredEdgeId: $edgeId}]->(tgt)
                 ON CREATE SET
                   r.inferred    = true,
                   r.origin      = 'semantic',
                   r.type        = $relationshipType,
                   r.confidence  = $confidence,
                   r.approvedBy  = $approvedBy,
                   r.approvedAt  = datetime($approvedAt),
                   r.createdAt   = datetime()`,
                {
                  orgId,
                  workspaceId,
                  sourceNodeId: nodeId,
                  targetType: edge.targetType,
                  targetDisplayLabel: tgtDomainLabel ?? edge.targetType,
                  targetName: edge.targetName,
                  edgeId,
                  relationshipType: edge.relationshipType,
                  confidence: edge.confidence,
                  approvedBy: "system:auto-accept",
                  approvedAt: now,
                },
              );
              autoAcceptedCount++;
            } else {
              pendingCount++;
            }
          }
        } finally {
          await sess.close();
        }

        return { pendingCount, autoAcceptedCount };
      }),
    );

    logger.info(
      {
        nodeId,
        entityType,
        orgId,
        ...result,
      },
      "ingestion-semantic-edge-infer: completed",
    );

    return {
      nodeId,
      edgesCreated: edges.length,
      autoAccepted: result.autoAcceptedCount,
    };
  },
);
