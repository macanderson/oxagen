/**
 * getPinnedSchema — the active-vocabulary resolver (Workspace Schema Registry §4.8).
 *
 * Resolves a workspace's pinned schema version into its **active vocabulary**:
 * the union of node labels + relationship types + properties across the
 * **enabled** schemas of the pinned version. This is the single function the
 * ingestion pipeline (§8) calls to ground extraction and validate writes, and
 * the §3.2 ontology Cypher guard consults for the relationship-type allow-list.
 *
 * Enabled-set resolution (§4.3 / §4.8): a schema's enabled state lives in
 * `schema_activations` keyed by stable schema identity (workspace + schema_name),
 * NOT by version. A missing activation row means **enabled**, whatever the
 * schema's source — the §4.8 default. The §4.3 "born disabled" rule for
 * user-authored and recommended schemas is enforced at *create* time instead,
 * by `getOrCreateDraftSchema` writing an explicit disabled activation row, so
 * nothing here has to branch on source.
 *
 * Caching: definitions are immutable per version, but the enabled set is live
 * config, so a hit also has to match an **activation fingerprint** (the sorted
 * enabled schema names). It is dropped on pin change, `schema.toggle`, or a
 * registry-config change via `invalidatePinnedSchemaCache(workspaceId)`.
 *
 * Two limits to know about. The cache is **per process** and holds one entry per
 * workspace with no TTL and no size cap, so a long-lived server that has served
 * many workspaces keeps every one of their vocabularies resident; and an
 * invalidation only reaches the process that ran the write, so an Inngest worker
 * can keep serving a vocabulary a toggle in the web app already changed. Both are
 * design gaps that want a shared invalidation channel plus a bounded, expiring
 * cache — not something a caller can work around.
 *
 * The cache sits mid-function, not in front of it: computing the fingerprint
 * needs the registry, version, schema and activation rows, so a hit still costs
 * those four queries and only saves the label/relationship/property reads. The
 * cached `PinnedSchema` is handed back by reference — treat it as read-only.
 *
 * Returns null when no version is pinned (registry inert → today's behavior).
 */

import { schema as db, withTenantDb } from "@oxagen/database";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type {
  PinnedSchema,
  PinnedLabel,
  PinnedRelationshipType,
  PinnedProperty,
} from "@oxagen/ingestion/validate";

// Re-export the shared active-vocabulary types so downstream streams (reconcile)
// and surfaces import the PinnedSchema shape from one place.
export type {
  PinnedSchema,
  PinnedLabel,
  PinnedRelationshipType,
  PinnedProperty,
} from "@oxagen/ingestion/validate";

interface CacheEntry {
  versionId: string;
  fingerprint: string;
  value: PinnedSchema;
}

// In-process cache keyed by workspaceId. A single entry per workspace is enough:
// a workspace has exactly one pinned version + activation set at a time. The
// stored versionId + fingerprint guard against a stale hit after a pin/toggle.
// Unbounded and process-local — see the module doc comment for what that costs.
const cache = new Map<string, CacheEntry>();

/**
 * Drop the cached active vocabulary for a workspace, in THIS process only.
 * Call after any pin change, `schema.toggle`, or registry-config change.
 */
export function invalidatePinnedSchemaCache(workspaceId: string): void {
  cache.delete(workspaceId);
}

/** Test-only: clear the entire cache. */
export function _clearPinnedSchemaCacheForTest(): void {
  cache.clear();
}

/**
 * Resolve the active vocabulary for a workspace's pinned version.
 *
 * @returns the PinnedSchema, or null when no version is pinned.
 */
export async function getPinnedSchema(
  orgId: string,
  workspaceId: string,
): Promise<PinnedSchema | null> {
  return withTenantDb(async (tx) => {
    // 1) Registry → pinned version + enforcement config.
    const registry = await tx
      .select({
        registryId: db.schemaRegistries.id,
        pinnedVersionId: db.schemaRegistries.pinnedVersionId,
        enforcementMode: db.schemaRegistries.enforcementMode,
        conformanceFloor: db.schemaRegistries.conformanceFloor,
      })
      .from(db.schemaRegistries)
      .where(
        and(
          eq(db.schemaRegistries.orgId, orgId),
          eq(db.schemaRegistries.workspaceId, workspaceId),
          isNull(db.schemaRegistries.deletedAt),
        ),
      )
      .limit(1);

    const reg = registry[0];
    if (!reg || reg.pinnedVersionId == null) {
      return null; // No registry or nothing pinned — registry inert.
    }
    const versionId = reg.pinnedVersionId;

    // 2) Version row (number).
    const versionRows = await tx
      .select({ versionNumber: db.schemaVersions.versionNumber })
      .from(db.schemaVersions)
      .where(eq(db.schemaVersions.id, versionId))
      .limit(1);
    const versionNumber = versionRows[0]?.versionNumber ?? 0;

    // 3) Schemas of the pinned version.
    const schemaRows = await tx
      .select({
        id: db.schemas.id,
        name: db.schemas.name,
        source: db.schemas.source,
      })
      .from(db.schemas)
      .where(
        and(eq(db.schemas.versionId, versionId), isNull(db.schemas.deletedAt)),
      );

    if (schemaRows.length === 0) {
      // Pinned version with no schemas — still a valid (empty) active vocabulary.
      return emptyVocabulary(
        reg.registryId,
        versionId,
        versionNumber,
        reg.enforcementMode,
        reg.conformanceFloor,
      );
    }

    // 4) Activation rows for these schema names (live config, version-independent).
    const names = schemaRows.map((s) => s.name);
    const activationRows = await tx
      .select({
        schemaName: db.schemaActivations.schemaName,
        enabled: db.schemaActivations.enabled,
      })
      .from(db.schemaActivations)
      .where(
        and(
          eq(db.schemaActivations.workspaceId, workspaceId),
          inArray(db.schemaActivations.schemaName, names),
          isNull(db.schemaActivations.deletedAt),
        ),
      );
    const enabledByName = new Map<string, boolean>();
    for (const a of activationRows) enabledByName.set(a.schemaName, a.enabled);

    // Filter to the ENABLED subset. No activation row → enabled default (§4.8).
    const enabledSchemas = schemaRows.filter(
      (s) => enabledByName.get(s.name) !== false,
    );
    if (enabledSchemas.length === 0) {
      return emptyVocabulary(
        reg.registryId,
        versionId,
        versionNumber,
        reg.enforcementMode,
        reg.conformanceFloor,
      );
    }

    // Activation fingerprint = sorted enabled schema names (live-config cache key).
    const fingerprint = [...enabledSchemas.map((s) => s.name)].sort().join("|");

    const cached = cache.get(workspaceId);
    if (
      cached &&
      cached.versionId === versionId &&
      cached.fingerprint === fingerprint
    ) {
      return cached.value;
    }

    const enabledSchemaIds = enabledSchemas.map((s) => s.id);
    const schemaNameById = new Map(enabledSchemas.map((s) => [s.id, s.name]));

    // 5) Node labels + relationship types for the enabled schemas of this version.
    const labelRows = await tx
      .select({
        id: db.nodeLabels.id,
        schemaId: db.nodeLabels.schemaId,
        name: db.nodeLabels.name,
        displayName: db.nodeLabels.displayName,
        description: db.nodeLabels.description,
        naturalKeyProps: db.nodeLabels.naturalKeyProps,
      })
      .from(db.nodeLabels)
      .where(
        and(
          eq(db.nodeLabels.versionId, versionId),
          inArray(db.nodeLabels.schemaId, enabledSchemaIds),
          isNull(db.nodeLabels.deletedAt),
        ),
      );

    const relRows = await tx
      .select({
        id: db.relationshipTypes.id,
        schemaId: db.relationshipTypes.schemaId,
        name: db.relationshipTypes.name,
        displayName: db.relationshipTypes.displayName,
        description: db.relationshipTypes.description,
        startLabel: db.relationshipTypes.startLabel,
        endLabel: db.relationshipTypes.endLabel,
        cardinality: db.relationshipTypes.cardinality,
      })
      .from(db.relationshipTypes)
      .where(
        and(
          eq(db.relationshipTypes.versionId, versionId),
          inArray(db.relationshipTypes.schemaId, enabledSchemaIds),
          isNull(db.relationshipTypes.deletedAt),
        ),
      );

    // 6) Every property of the pinned version in one query, then grouped by
    //    owner id. The query filters on versionId only, so properties belonging
    //    to a DISABLED schema are read and then dropped by the grouping (the
    //    propsByLabel / propsByRel lookups below are keyed by the enabled
    //    labels' and relationship types' ids). Correct, but it reads more rows
    //    than the vocabulary needs on a workspace with many disabled schemas.
    const labelIds = labelRows.map((l) => l.id);
    const relIds = relRows.map((r) => r.id);
    const propRows =
      labelIds.length === 0 && relIds.length === 0
        ? []
        : await tx
            .select({
              nodeLabelId: db.schemaProperties.nodeLabelId,
              relationshipTypeId: db.schemaProperties.relationshipTypeId,
              key: db.schemaProperties.key,
              dataType: db.schemaProperties.dataType,
              required: db.schemaProperties.required,
              description: db.schemaProperties.description,
              enumValues: db.schemaProperties.enumValues,
              itemType: db.schemaProperties.itemType,
              constraints: db.schemaProperties.constraints,
              example: db.schemaProperties.example,
            })
            .from(db.schemaProperties)
            .where(
              and(
                eq(db.schemaProperties.versionId, versionId),
                isNull(db.schemaProperties.deletedAt),
              ),
            );

    const propsByLabel = new Map<string, PinnedProperty[]>();
    const propsByRel = new Map<string, PinnedProperty[]>();
    for (const p of propRows) {
      const prop = toPinnedProperty(p);
      if (p.nodeLabelId) {
        const arr = propsByLabel.get(p.nodeLabelId) ?? [];
        arr.push(prop);
        propsByLabel.set(p.nodeLabelId, arr);
      } else if (p.relationshipTypeId) {
        const arr = propsByRel.get(p.relationshipTypeId) ?? [];
        arr.push(prop);
        propsByRel.set(p.relationshipTypeId, arr);
      }
    }

    const labels: PinnedLabel[] = labelRows.map((l) => ({
      schemaName: schemaNameById.get(l.schemaId) ?? "",
      name: l.name,
      displayName: l.displayName,
      description: l.description ?? null,
      naturalKeyProps: l.naturalKeyProps ?? [],
      properties: propsByLabel.get(l.id) ?? [],
    }));

    const relationshipTypes: PinnedRelationshipType[] = relRows.map((r) => ({
      schemaName: schemaNameById.get(r.schemaId) ?? "",
      name: r.name,
      displayName: r.displayName,
      description: r.description ?? null,
      startLabel: r.startLabel ?? null,
      endLabel: r.endLabel ?? null,
      cardinality:
        (r.cardinality as PinnedRelationshipType["cardinality"]) ?? null,
      properties: propsByRel.get(r.id) ?? [],
    }));

    const value: PinnedSchema = {
      registryId: reg.registryId,
      versionId,
      versionNumber,
      enforcementMode: reg.enforcementMode as PinnedSchema["enforcementMode"],
      conformanceFloor: Number(reg.conformanceFloor),
      labels,
      relationshipTypes,
    };

    cache.set(workspaceId, { versionId, fingerprint, value });
    return value;
  });
}

function emptyVocabulary(
  registryId: string,
  versionId: string,
  versionNumber: number,
  enforcementMode: string,
  conformanceFloor: string,
): PinnedSchema {
  return {
    registryId,
    versionId,
    versionNumber,
    enforcementMode: enforcementMode as PinnedSchema["enforcementMode"],
    conformanceFloor: Number(conformanceFloor),
    labels: [],
    relationshipTypes: [],
  };
}

function toPinnedProperty(p: {
  key: string;
  dataType: string;
  required: boolean;
  description: string | null;
  enumValues: string[] | null;
  itemType: string | null;
  constraints: unknown;
  example: string | null;
}): PinnedProperty {
  const c = (p.constraints ?? {}) as PinnedProperty["constraints"];
  return {
    key: p.key,
    dataType: p.dataType as PinnedProperty["dataType"],
    required: p.required,
    description: p.description ?? null,
    enumValues: p.enumValues ?? null,
    itemType: p.itemType ?? null,
    constraints: {
      min: c.min,
      max: c.max,
      minLength: c.minLength,
      maxLength: c.maxLength,
      pattern: c.pattern,
    },
    example: p.example ?? null,
  };
}
