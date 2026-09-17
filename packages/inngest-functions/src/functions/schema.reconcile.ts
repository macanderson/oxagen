import { createFunction } from "../create-function";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { generateObjectFor, resolveModelFundingSource } from "@oxagen/ai";
import { CREDIT_REASONS } from "@oxagen/billing";
import { z } from "zod";
import { logger } from "../logger";

// ── Pure helper — exported for unit testing ────────────────────────────────────

/**
 * Build the pruned properties map: returns only the properties whose keys
 * appear in `schemaKeys`. Removed keys are returned in `removedKeys`.
 *
 * Direction-agnostic: downgrading to an older schema version with prune=true
 * removes properties that a prior forward-heal added but aren't in the older schema.
 */
export function buildPrunedProperties(
  existing: Record<string, unknown>,
  schemaKeys: string[],
  reservedKeys: ReadonlySet<string> = EMPTY_RESERVED,
): { pruned: Record<string, unknown>; removedKeys: string[] } {
  const schemaKeySet = new Set(schemaKeys);
  const pruned: Record<string, unknown> = {};
  const removedKeys: string[] = [];

  for (const [key, value] of Object.entries(existing)) {
    if (schemaKeySet.has(key) || reservedKeys.has(key)) {
      pruned[key] = value;
    } else {
      removedKeys.push(key);
    }
  }

  return { pruned, removedKeys };
}

const EMPTY_RESERVED: ReadonlySet<string> = new Set<string>();

/**
 * Relationship properties the PLATFORM owns. They never appear in a user
 * schema, so a prune pass computed from schema keys alone classifies every one
 * of them as off-schema.
 *
 * That was harmless only while the write merged (`SET r += $props`), which
 * cannot delete. The moment the write gained removal semantics, pruning a
 * relationship would have stripped its bi-temporal history (`validFrom`,
 * `validTo`, `recordedAt`, `invalidatedAt`) and its tenancy stamp (`orgId`,
 * `workspaceId`) — strictly worse than the bug being fixed. The reserved set is
 * what makes replacement safe, and it is checked by
 * `RESERVED_RELATIONSHIP_PROPERTY_KEYS` covering every `r.<key>` this repo
 * writes onto a relationship.
 */
export const RESERVED_RELATIONSHIP_PROPERTY_KEYS: ReadonlySet<string> = new Set(
  [
    "orgId",
    "workspaceId",
    "is_system",
    "createdAt",
    "updatedAt",
    "validFrom",
    "validTo",
    "recordedAt",
    "invalidatedAt",
  ],
);

/**
 * Quote a property name for interpolation into a REMOVE clause.
 *
 * Cypher has no parameter form for a property NAME, so the key has to be
 * interpolated. The safe move is to ESCAPE every legal name, not to restrict to
 * the subset that needs no escaping: `schema.property.upsert` accepts any
 * non-empty string up to 200 characters, so `legacy-note` and `display name`
 * are ordinary valid property names. A guard that only admitted
 * JavaScript-identifier syntax would throw on data the prune exists to handle,
 * failing the reconcile step on exactly the legacy keys it was meant to clean
 * up.
 *
 * Backtick-quoting covers every such name, and an embedded backtick is escaped
 * by doubling it — which is Cypher's own rule for quoted identifiers, and what
 * stops a crafted key from closing the quote and injecting a clause.
 */
function quotePropertyKey(key: string): string {
  return `\`${key.replace(/`/g, "``")}\``;
}

/**
 * Build the write-back for one relationship.
 *
 * `SET r += $props` MERGES: a key omitted from the map stays on the
 * relationship. So pruning that only omits keys removes nothing while the job
 * increments `prunedRelationships` and reports success — the counter would have
 * looked healthy for work that never happened. Removal has to be stated, so
 * rejected keys get an explicit `REMOVE r.\`key\``.
 *
 * Removal is enumerated rather than achieved by replacement (`SET r = $props`)
 * on purpose: with replacement, one key missing from the reserved set silently
 * deletes data, whereas here deleting a property requires naming it.
 *
 * Every key is backtick-quoted, so a legal-but-awkward property name —
 * `legacy-note`, `display name`, one containing a backtick — is pruned rather
 * than rejected.
 */
export function buildRelationshipWriteBack(removedKeys: readonly string[]): {
  setClause: string;
  removeClause: string;
} {
  for (const key of removedKeys) {
    // The only input that cannot be expressed as a quoted identifier. Kept as a
    // throw rather than a skip: skipping is how a prune reports success having
    // removed nothing, which is the defect this builder exists to fix.
    if (key.length === 0) {
      throw new Error(
        "schema.reconcile: an empty relationship property key cannot be pruned",
      );
    }
  }
  return {
    setClause: "SET r += $props",
    removeClause:
      removedKeys.length > 0
        ? ` REMOVE ${removedKeys.map((k) => `r.${quotePropertyKey(k)}`).join(", ")}`
        : "",
  };
}

/**
 * Parse a KnowledgeNode's `properties` column into a plain object.
 *
 * Canonical storage (see graph.node.upsert) serializes the property bag to a
 * JSON STRING — Neo4j node property values must be primitives/arrays, never a
 * map. Read with this helper and write back with `JSON.stringify(...)` to
 * stay consistent with ingestion. Also accepts an already-parsed object,
 * since some callers may hand one in directly.
 */
export function parseNodeProps(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw))
    return raw as Record<string, unknown>;
  return {};
}

// ── Batch size ────────────────────────────────────────────────────────────────

const BATCH_SIZE = 50;

// Per-node / per-relationship AI derivation wall-clock cap. The AI gateway can
// stall indefinitely; without a bound the whole reconcile step hangs and the
// job is stuck "running" forever (the try/catch around the call cannot rescue a
// hang — only a throw). AbortSignal.timeout turns a stall into an AbortError the
// existing catch handles, letting the worker skip that node and continue.
const AI_DERIVE_TIMEOUT_MS = 30_000;

// ── Reconcile state shape ─────────────────────────────────────────────────────

interface ReconcileState {
  totalNodes: number;
  processedNodes: number;
  updatedNodes: number;
  totalRelationships: number;
  processedRelationships: number;
  updatedRelationships: number;
  prune: boolean;
  prunedNodes: number;
  prunedRelationships: number;
  prunedPropertyKeys: Record<string, string[]>;
}

// ── Inngest function ──────────────────────────────────────────────────────────

export const [schemaReconcile] = createFunction(
  {
    id: "schema-reconcile",
    retries: 2,
    concurrency: { limit: 2, key: "event.data.orgId" },
  },
  { event: "schema/reconcile.start" },
  async ({ event, step }) => {
    const { orgId, workspaceId, executionId, versionId, prune } =
      event.data as {
        orgId: string;
        workspaceId: string;
        executionId: string;
        versionId: string;
        prune: boolean;
      };

    // ── Step: mark the execution as running ────────────────────────────────────
    await step.run("start", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(db.agentExecutions)
            .set({ status: "running", startedAt: new Date() })
            .where(
              and(
                eq(db.agentExecutions.id, executionId),
                eq(db.agentExecutions.orgId, orgId),
              ),
            ),
        ),
      ),
    );

    // ── Step: load the target schema definition from DB ────────────────────────
    const schemaDefinition = await step.run("load-schema", async () => {
      return runInTenantScope({ orgId, workspaceId }, async () => {
        // Resolve version row by publicId.
        const versionRow = await withTenantDb((tx) =>
          tx.query.schemaVersions.findFirst({
            where: and(
              eq(db.schemaVersions.publicId, versionId),
              eq(db.schemaVersions.orgId, orgId),
              eq(db.schemaVersions.workspaceId, workspaceId),
            ),
            columns: { id: true, versionNumber: true },
          }),
        );

        if (!versionRow) {
          throw new Error(
            `schema.reconcile: schema version not found: ${versionId}`,
          );
        }

        // Load all schemas belonging to this version.
        const allSchemas = await withTenantDb((tx) =>
          tx.query.schemas.findMany({
            where: and(
              eq(db.schemas.versionId, versionRow.id),
              eq(db.schemas.orgId, orgId),
              eq(db.schemas.workspaceId, workspaceId),
              isNull(db.schemas.deletedAt),
            ),
            columns: { id: true, name: true },
          }),
        );

        if (allSchemas.length === 0) {
          logger.info(
            { orgId, workspaceId, versionId },
            "schema.reconcile: no schemas in target version",
          );
          return {
            versionInternalId: versionRow.id,
            labelNames: [] as string[],
            relTypeNames: [] as string[],
            labelSchemaMap: {} as Record<
              string,
              {
                labelId: string;
                properties: Array<{
                  key: string;
                  dataType: string;
                  required: boolean;
                  description: string | null;
                }>;
              }
            >,
            relTypeSchemaMap: {} as Record<
              string,
              {
                properties: Array<{
                  key: string;
                  dataType: string;
                  required: boolean;
                  description: string | null;
                }>;
              }
            >,
          };
        }

        // Load schema activations to determine enabled schemas.
        const activations = await withTenantDb((tx) =>
          tx.query.schemaActivations.findMany({
            where: and(
              eq(db.schemaActivations.orgId, orgId),
              eq(db.schemaActivations.workspaceId, workspaceId),
              isNull(db.schemaActivations.deletedAt),
            ),
            columns: { schemaName: true, enabled: true },
          }),
        );

        const activationMap = new Map(
          activations.map((a) => [a.schemaName, a.enabled]),
        );
        // Schemas with no activation record are enabled by default.
        const enabledSchemaIds = allSchemas
          .filter((s) => activationMap.get(s.name) !== false)
          .map((s) => s.id);

        if (enabledSchemaIds.length === 0) {
          return {
            versionInternalId: versionRow.id,
            labelNames: [] as string[],
            relTypeNames: [] as string[],
            labelSchemaMap: {} as Record<
              string,
              {
                labelId: string;
                properties: Array<{
                  key: string;
                  dataType: string;
                  required: boolean;
                  description: string | null;
                }>;
              }
            >,
            relTypeSchemaMap: {} as Record<
              string,
              {
                properties: Array<{
                  key: string;
                  dataType: string;
                  required: boolean;
                  description: string | null;
                }>;
              }
            >,
          };
        }

        // Load node labels for enabled schemas.
        const labels = await withTenantDb((tx) =>
          tx.query.nodeLabels.findMany({
            where: and(
              eq(db.nodeLabels.versionId, versionRow.id),
              inArray(db.nodeLabels.schemaId, enabledSchemaIds),
              eq(db.nodeLabels.orgId, orgId),
              isNull(db.nodeLabels.deletedAt),
            ),
            columns: { id: true, name: true },
          }),
        );

        // Load relationship types for enabled schemas.
        const relTypes = await withTenantDb((tx) =>
          tx.query.relationshipTypes.findMany({
            where: and(
              eq(db.relationshipTypes.versionId, versionRow.id),
              inArray(db.relationshipTypes.schemaId, enabledSchemaIds),
              eq(db.relationshipTypes.orgId, orgId),
              isNull(db.relationshipTypes.deletedAt),
            ),
            columns: { id: true, name: true },
          }),
        );

        // Load properties for all labels and rel types.
        const allProperties = await withTenantDb((tx) =>
          tx.query.schemaProperties.findMany({
            where: and(
              eq(db.schemaProperties.versionId, versionRow.id),
              eq(db.schemaProperties.orgId, orgId),
              isNull(db.schemaProperties.deletedAt),
            ),
            columns: {
              id: true,
              nodeLabelId: true,
              relationshipTypeId: true,
              key: true,
              dataType: true,
              required: true,
              description: true,
            },
          }),
        );

        // Build label schema map (plain object, Inngest step results must be serializable).
        const labelSchemaMap: Record<
          string,
          {
            labelId: string;
            properties: Array<{
              key: string;
              dataType: string;
              required: boolean;
              description: string | null;
            }>;
          }
        > = {};
        for (const label of labels) {
          const props = allProperties
            .filter((p) => p.nodeLabelId === label.id)
            .map((p) => ({
              key: p.key,
              dataType: p.dataType,
              required: p.required,
              description: p.description,
            }));
          labelSchemaMap[label.name] = { labelId: label.id, properties: props };
        }

        // Build rel type schema map.
        const relTypeSchemaMap: Record<
          string,
          {
            properties: Array<{
              key: string;
              dataType: string;
              required: boolean;
              description: string | null;
            }>;
          }
        > = {};
        for (const relType of relTypes) {
          const props = allProperties
            .filter((p) => p.relationshipTypeId === relType.id)
            .map((p) => ({
              key: p.key,
              dataType: p.dataType,
              required: p.required,
              description: p.description,
            }));
          relTypeSchemaMap[relType.name] = { properties: props };
        }

        return {
          versionInternalId: versionRow.id,
          labelNames: labels.map((l) => l.name),
          relTypeNames: relTypes.map((r) => r.name),
          labelSchemaMap,
          relTypeSchemaMap,
        };
      });
    });

    // Exit early if there are no labels to reconcile.
    if (
      schemaDefinition.labelNames.length === 0 &&
      schemaDefinition.relTypeNames.length === 0
    ) {
      await step.run("complete-empty", () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(db.agentExecutions)
              .set({
                status: "completed",
                completedAt: new Date(),
                outputPayload: {
                  totalNodes: 0,
                  processedNodes: 0,
                  updatedNodes: 0,
                  totalRelationships: 0,
                  processedRelationships: 0,
                  updatedRelationships: 0,
                  prunedNodes: 0,
                  prunedRelationships: 0,
                },
              })
              .where(eq(db.agentExecutions.id, executionId)),
          ),
        ),
      );
      return {
        executionId,
        status: "completed",
        totalNodes: 0,
        totalRelationships: 0,
      };
    }

    // ── Step: count total nodes and relationships to reconcile ─────────────────
    const counts = await step.run("count-nodes", async () => {
      return runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();

        let totalNodes = 0;
        let totalRelationships = 0;

        if (schemaDefinition.labelNames.length > 0) {
          const nodeResult = await session.run(
            `MATCH (n:GraphNode)
             WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId AND n.label IN $labels
             RETURN count(n) AS total`,
            { orgId, workspaceId, labels: schemaDefinition.labelNames },
          );
          totalNodes = (nodeResult.records[0]?.get("total") as
            | { toNumber?: () => number }
            | number
            | undefined)
            ? typeof (
                nodeResult.records[0]?.get("total") as {
                  toNumber?: () => number;
                }
              ).toNumber === "function"
              ? (
                  nodeResult.records[0]?.get("total") as {
                    toNumber: () => number;
                  }
                ).toNumber()
              : Number(nodeResult.records[0]?.get("total") ?? 0)
            : 0;
        }

        if (schemaDefinition.relTypeNames.length > 0) {
          const relResult = await session.run(
            `MATCH (n:GraphNode)-[r]->(m:GraphNode)
             WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId AND type(r) IN $relTypes
             RETURN count(r) AS total`,
            { orgId, workspaceId, relTypes: schemaDefinition.relTypeNames },
          );
          totalRelationships =
            typeof (
              relResult.records[0]?.get("total") as { toNumber?: () => number }
            ).toNumber === "function"
              ? (
                  relResult.records[0]?.get("total") as {
                    toNumber: () => number;
                  }
                ).toNumber()
              : Number(relResult.records[0]?.get("total") ?? 0);
        }

        return { totalNodes, totalRelationships };
      });
    });

    // Update state with totals.
    await step.run("update-state-counts", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(db.agentExecutions)
            .set({
              state: {
                totalNodes: counts.totalNodes,
                processedNodes: 0,
                updatedNodes: 0,
                totalRelationships: counts.totalRelationships,
                processedRelationships: 0,
                updatedRelationships: 0,
                prune,
                prunedNodes: 0,
                prunedRelationships: 0,
                prunedPropertyKeys: {},
              },
            })
            .where(eq(db.agentExecutions.id, executionId)),
        ),
      ),
    );

    // ── Step: reconcile all nodes (in-step pagination, single Inngest checkpoint) ──
    const nodeResults = await step.run("reconcile-all-nodes", async () => {
      if (schemaDefinition.labelNames.length === 0) {
        return {
          processedNodes: 0,
          updatedNodes: 0,
          prunedNodes: 0,
          prunedPropertyKeys: {} as Record<string, string[]>,
        };
      }

      return runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        let skip = 0;
        let processedNodes = 0;
        let updatedNodes = 0;
        let prunedNodes = 0;
        const prunedPropertyKeys: Record<string, string[]> = {};

        for (;;) {
          const batchResult = await session.run(
            `MATCH (n:GraphNode)
             WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId AND n.label IN $labels
             RETURN n.publicId AS nodeId, n.label AS label, n.properties AS properties, n.displayName AS displayName
             SKIP $skip LIMIT $batchSize`,
            {
              orgId,
              workspaceId,
              labels: schemaDefinition.labelNames,
              skip,
              batchSize: BATCH_SIZE,
            },
          );

          if (batchResult.records.length === 0) break;

          for (const record of batchResult.records) {
            const nodeId = record.get("nodeId") as string;
            const label = record.get("label") as string;
            // `n.properties` is a JSON string (canonical storage), not a map.
            const existingProps = parseNodeProps(record.get("properties"));

            const labelSchema = schemaDefinition.labelSchemaMap[label];
            if (!labelSchema) {
              processedNodes++;
              continue;
            }

            const schemaKeys = labelSchema.properties.map((p) => p.key);
            let newProps = { ...existingProps };
            let nodeUpdated = false;

            // AI-derive missing required properties that have a description.
            const missingRequired = labelSchema.properties.filter(
              (p) => p.required && p.description && !(p.key in existingProps),
            );

            if (missingRequired.length > 0) {
              try {
                const missingSchema = z.object({
                  derivedProps: z.record(z.unknown()),
                });
                const { object } = await generateObjectFor({
                  // Platform-vs-org funding, resolved rather than assumed. The parameter is
                  // required for that reason: it used to default to `platform`, and every
                  // caller took the default, so an organisation that had brought its own key
                  // was billed for this call anyway (ADR-053 §3).
                  fundedBy: (await resolveModelFundingSource(orgId)).fundedBy,
                  chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
                  schema: missingSchema,
                  prompt: `You are completing missing required schema properties for a knowledge graph node with label "${label}".
Existing properties: ${JSON.stringify(existingProps)}
Missing required properties to derive:
${missingRequired.map((p) => `  - ${p.key} (${p.dataType}): ${p.description}`).join("\n")}
Return only the derived property key-value pairs in the derivedProps field.`,
                  telemetry: {
                    orgId,
                    workspaceId,
                    surface: "runner" as const,
                    messageId: null,
                  },
                  // Bound the call so a stalled gateway can't hang the worker.
                  abortSignal: AbortSignal.timeout(AI_DERIVE_TIMEOUT_MS),
                  maxRetries: 0, // Inngest owns the retry policy for this step.
                });
                if (
                  object.derivedProps &&
                  typeof object.derivedProps === "object"
                ) {
                  newProps = { ...newProps, ...object.derivedProps };
                  nodeUpdated = true;
                }
              } catch (aiErr) {
                logger.warn(
                  { nodeId, label, err: aiErr },
                  "schema.reconcile: AI derivation failed for node — skipping AI step",
                );
              }
            }

            // Prune off-schema properties if requested.
            if (prune) {
              const { pruned, removedKeys } = buildPrunedProperties(
                newProps,
                schemaKeys,
              );
              if (removedKeys.length > 0) {
                newProps = pruned;
                nodeUpdated = true;
                prunedNodes++;
                prunedPropertyKeys[nodeId] = removedKeys;
              }
            }

            // Write back to Neo4j only if something changed.
            if (nodeUpdated) {
              await session.run(
                `MATCH (n:GraphNode {publicId: $nodeId, orgId: $orgId, workspaceId: $workspaceId})
                 SET n.properties = $properties`,
                // Serialize back to a JSON string — Neo4j rejects raw maps as
                // property values, and ingestion stores this column the same way.
                {
                  nodeId,
                  orgId,
                  workspaceId,
                  properties: JSON.stringify(newProps),
                },
              );
              updatedNodes++;
            }

            processedNodes++;
          }

          skip += BATCH_SIZE;
          if (batchResult.records.length < BATCH_SIZE) break;
        }

        return {
          processedNodes,
          updatedNodes,
          prunedNodes,
          prunedPropertyKeys,
        };
      });
    });

    // ── Step: reconcile all relationships ──────────────────────────────────────
    const relResults = await step.run(
      "reconcile-all-relationships",
      async () => {
        if (schemaDefinition.relTypeNames.length === 0) {
          return {
            processedRelationships: 0,
            updatedRelationships: 0,
            prunedRelationships: 0,
          };
        }

        return runInTenantScope({ orgId, workspaceId }, async () => {
          const session = scopedSession();
          let skip = 0;
          let processedRelationships = 0;
          let updatedRelationships = 0;
          let prunedRelationships = 0;

          for (;;) {
            const batchResult = await session.run(
              `MATCH (a:GraphNode)-[r]->(b:GraphNode)
             WHERE a.orgId = $orgId AND a.workspaceId = $workspaceId AND type(r) IN $relTypes
             RETURN elementId(r) AS relElemId, type(r) AS relType, properties(r) AS props
             SKIP $skip LIMIT $batchSize`,
              {
                orgId,
                workspaceId,
                relTypes: schemaDefinition.relTypeNames,
                skip,
                batchSize: BATCH_SIZE,
              },
            );

            if (batchResult.records.length === 0) break;

            for (const record of batchResult.records) {
              const relElemId = record.get("relElemId") as string;
              const relType = record.get("relType") as string;
              const existingProps = (record.get("props") ?? {}) as Record<
                string,
                unknown
              >;

              const relSchema = schemaDefinition.relTypeSchemaMap[relType];
              if (!relSchema) {
                processedRelationships++;
                continue;
              }

              const schemaKeys = relSchema.properties.map((p) => p.key);
              let newProps = { ...existingProps };
              let relUpdated = false;

              // AI-derive missing required properties for relationships.
              const missingRequired = relSchema.properties.filter(
                (p) => p.required && p.description && !(p.key in existingProps),
              );

              if (missingRequired.length > 0) {
                try {
                  const missingSchema = z.object({
                    derivedProps: z.record(z.unknown()),
                  });
                  const { object } = await generateObjectFor({
                    // Platform-vs-org funding, resolved rather than assumed. The parameter is
                    // required for that reason: it used to default to `platform`, and every
                    // caller took the default, so an organisation that had brought its own key
                    // was billed for this call anyway (ADR-053 §3).
                    fundedBy: (await resolveModelFundingSource(orgId)).fundedBy,
                    chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
                    schema: missingSchema,
                    prompt: `You are completing missing required schema properties for a knowledge graph relationship of type "${relType}".
Existing properties: ${JSON.stringify(existingProps)}
Missing required properties to derive:
${missingRequired.map((p) => `  - ${p.key} (${p.dataType}): ${p.description}`).join("\n")}
Return only the derived property key-value pairs in the derivedProps field.`,
                    telemetry: {
                      orgId,
                      workspaceId,
                      surface: "runner" as const,
                      messageId: null,
                    },
                    // Bound the call so a stalled gateway can't hang the worker.
                    abortSignal: AbortSignal.timeout(AI_DERIVE_TIMEOUT_MS),
                    maxRetries: 0, // Inngest owns the retry policy for this step.
                  });
                  if (
                    object.derivedProps &&
                    typeof object.derivedProps === "object"
                  ) {
                    newProps = { ...newProps, ...object.derivedProps };
                    relUpdated = true;
                  }
                } catch (aiErr) {
                  logger.warn(
                    { relElemId, relType, err: aiErr },
                    "schema.reconcile: AI derivation failed for relationship — skipping AI step",
                  );
                }
              }

              // Prune off-schema properties from relationships if requested.
              // `properties(r)` returns EVERY property including the
              // platform-owned ones, so the reserved set is passed here or the
              // prune would target the relationship's own temporal and tenancy
              // metadata.
              let removedRelKeys: readonly string[] = [];
              if (prune) {
                const { pruned, removedKeys } = buildPrunedProperties(
                  newProps,
                  schemaKeys,
                  RESERVED_RELATIONSHIP_PROPERTY_KEYS,
                );
                if (removedKeys.length > 0) {
                  newProps = pruned;
                  removedRelKeys = removedKeys;
                  relUpdated = true;
                  prunedRelationships++;
                }
              }

              // Write back to Neo4j only if something changed.
              if (relUpdated) {
                // Anchor the write to the SAME tenant the batch read anchored
                // to. An elementId is a global graph address, so an unanchored
                // `MATCH ()-[r]->()` would write any relationship in the store
                // whose id happened to collide — and it never ran at all,
                // because the scoped-session tenancy guard rejects Cypher that
                // binds no orgId. $orgId/$workspaceId are injected by the seam.
                const { setClause, removeClause } =
                  buildRelationshipWriteBack(removedRelKeys);
                await session.run(
                  `MATCH (a:GraphNode)-[r]->(b:GraphNode)
                   WHERE elementId(r) = $relElemId
                     AND a.orgId = $orgId AND a.workspaceId = $workspaceId
                   ${setClause}${removeClause}`,
                  { relElemId, props: newProps },
                );
                updatedRelationships++;
              }

              processedRelationships++;
            }

            skip += BATCH_SIZE;
            if (batchResult.records.length < BATCH_SIZE) break;
          }

          return {
            processedRelationships,
            updatedRelationships,
            prunedRelationships,
          };
        });
      },
    );

    // ── Step: finalize the execution record ────────────────────────────────────
    await step.run("complete", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          const finalState: ReconcileState = {
            totalNodes: counts.totalNodes,
            processedNodes: nodeResults.processedNodes,
            updatedNodes: nodeResults.updatedNodes,
            totalRelationships: counts.totalRelationships,
            processedRelationships: relResults.processedRelationships,
            updatedRelationships: relResults.updatedRelationships,
            prune,
            prunedNodes: nodeResults.prunedNodes,
            prunedRelationships: relResults.prunedRelationships,
            prunedPropertyKeys: nodeResults.prunedPropertyKeys,
          };

          const completedAt = new Date();

          // Look up startedAt to compute latencyMs.
          const execRow = await tx.query.agentExecutions.findFirst({
            where: eq(db.agentExecutions.id, executionId),
            columns: { startedAt: true },
          });

          const latencyMs = execRow?.startedAt
            ? completedAt.getTime() - execRow.startedAt.getTime()
            : null;

          await tx
            .update(db.agentExecutions)
            .set({
              status: "completed",
              completedAt,
              latencyMs,
              outputPayload: finalState,
              state: finalState,
            })
            .where(eq(db.agentExecutions.id, executionId));
        }),
      ),
    );

    logger.info(
      {
        executionId,
        orgId,
        workspaceId,
        versionId,
        prune,
        totalNodes: counts.totalNodes,
        updatedNodes: nodeResults.updatedNodes,
        prunedNodes: nodeResults.prunedNodes,
        totalRelationships: counts.totalRelationships,
        updatedRelationships: relResults.updatedRelationships,
        prunedRelationships: relResults.prunedRelationships,
      },
      "schema.reconcile: completed",
    );

    return {
      executionId,
      status: "completed",
      totalNodes: counts.totalNodes,
      processedNodes: nodeResults.processedNodes,
      updatedNodes: nodeResults.updatedNodes,
      totalRelationships: counts.totalRelationships,
      processedRelationships: relResults.processedRelationships,
      updatedRelationships: relResults.updatedRelationships,
      prunedNodes: nodeResults.prunedNodes,
      prunedRelationships: relResults.prunedRelationships,
    };
  },
);
