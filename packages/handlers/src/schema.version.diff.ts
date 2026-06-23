import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaVersionDiff } from "@oxagen/oxagen/contracts/schema.version.diff";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { logger } from "./logger";

type LabelRow = {
  id: string;
  schemaId: string;
  name: string;
  displayName: string;
  description: string | null;
  naturalKeyProps: string[];
};

type RelRow = {
  id: string;
  schemaId: string;
  name: string;
  displayName: string;
  description: string | null;
  startLabel: string | null;
  endLabel: string | null;
  cardinality: string | null;
};

type PropRow = {
  id: string;
  nodeLabelId: string | null;
  relationshipTypeId: string | null;
  key: string;
  dataType: string;
  required: boolean;
  description: string | null;
};

export const schemaVersionDiffHandler: CapabilityHandler<typeof schemaVersionDiff> = async (
  input,
  ctx,
) => {
  const { fromVersionId, toVersionId } = input;

  const {
    fromSchemas,
    toSchemas,
    fromLabels,
    toLabels,
    fromRels,
    toRels,
    fromProps,
    toProps,
    schemaNameMap,
  } = await withTenantDb(async (tx) => {
    // Resolve internal IDs from publicIds
    const versionRows = await tx
      .select()
      .from(db.schemaVersions)
      .where(
        inArray(db.schemaVersions.publicId, [fromVersionId, toVersionId]),
      );

    const fromVersion = versionRows.find((v) => v.publicId === fromVersionId);
    const toVersion = versionRows.find((v) => v.publicId === toVersionId);

    if (!fromVersion) throw new Error(`Version ${fromVersionId} not found`);
    if (!toVersion) throw new Error(`Version ${toVersionId} not found`);

    const fromInternalId = fromVersion.id;
    const toInternalId = toVersion.id;

    // Load schemas for both versions
    const [fromSchemas, toSchemas] = await Promise.all([
      tx.select().from(db.schemas).where(
        and(eq(db.schemas.versionId, fromInternalId), isNull(db.schemas.deletedAt)),
      ),
      tx.select().from(db.schemas).where(
        and(eq(db.schemas.versionId, toInternalId), isNull(db.schemas.deletedAt)),
      ),
    ]);

    const allSchemaIds = [
      ...fromSchemas.map((s) => s.id),
      ...toSchemas.map((s) => s.id),
    ];

    // Build a name map from schema id → schema name (across both versions)
    const schemaNameMap = new Map<string, string>();
    for (const s of [...fromSchemas, ...toSchemas]) {
      schemaNameMap.set(s.id, s.name);
    }

    const [fromLabels, toLabels, fromRels, toRels] = await Promise.all([
      allSchemaIds.length > 0
        ? tx.select().from(db.nodeLabels).where(
            and(
              eq(db.nodeLabels.versionId, fromInternalId),
              isNull(db.nodeLabels.deletedAt),
            ),
          )
        : Promise.resolve([]),
      allSchemaIds.length > 0
        ? tx.select().from(db.nodeLabels).where(
            and(
              eq(db.nodeLabels.versionId, toInternalId),
              isNull(db.nodeLabels.deletedAt),
            ),
          )
        : Promise.resolve([]),
      allSchemaIds.length > 0
        ? tx.select().from(db.relationshipTypes).where(
            and(
              eq(db.relationshipTypes.versionId, fromInternalId),
              isNull(db.relationshipTypes.deletedAt),
            ),
          )
        : Promise.resolve([]),
      allSchemaIds.length > 0
        ? tx.select().from(db.relationshipTypes).where(
            and(
              eq(db.relationshipTypes.versionId, toInternalId),
              isNull(db.relationshipTypes.deletedAt),
            ),
          )
        : Promise.resolve([]),
    ]);

    // Load properties
    const fromLabelIds = fromLabels.map((l) => l.id);
    const toLabelIds = toLabels.map((l) => l.id);
    const fromRelIds = fromRels.map((r) => r.id);
    const toRelIds = toRels.map((r) => r.id);

    const [fromProps, toProps] = await Promise.all([
      tx.select().from(db.schemaProperties).where(
        and(
          eq(db.schemaProperties.versionId, fromInternalId),
          isNull(db.schemaProperties.deletedAt),
        ),
      ),
      tx.select().from(db.schemaProperties).where(
        and(
          eq(db.schemaProperties.versionId, toInternalId),
          isNull(db.schemaProperties.deletedAt),
        ),
      ),
    ]);

    return { fromSchemas, toSchemas, fromLabels, toLabels, fromRels, toRels, fromProps, toProps, schemaNameMap };
  });

  // ── Schema diff ──────────────────────────────────────────────────────────────

  const fromSchemaNames = new Set(fromSchemas.map((s) => s.name));
  const toSchemaNames = new Set(toSchemas.map((s) => s.name));

  const schemasAdded = [...toSchemaNames].filter((n) => !fromSchemaNames.has(n));
  const schemasRemoved = [...fromSchemaNames].filter((n) => !toSchemaNames.has(n));

  // ── Label diff ───────────────────────────────────────────────────────────────

  // Key labels by "schemaName:labelName"
  const fromLabelMap = new Map(
    fromLabels.map((l) => [`${schemaNameMap.get(l.schemaId) ?? ""}:${l.name}`, l]),
  );
  const toLabelMap = new Map(
    toLabels.map((l) => [`${schemaNameMap.get(l.schemaId) ?? ""}:${l.name}`, l]),
  );

  const labelsAdded: Array<{ schemaName: string; labelName: string }> = [];
  const labelsRemoved: Array<{ schemaName: string; labelName: string }> = [];
  const labelsChanged: Array<{ schemaName: string; labelName: string; changes: string[] }> = [];

  for (const [key, toLabel] of toLabelMap) {
    const fromLabel = fromLabelMap.get(key);
    const [sn, ln] = key.split(":");
    if (!sn || !ln) continue;
    if (!fromLabel) {
      labelsAdded.push({ schemaName: sn, labelName: ln });
    } else {
      const changes: string[] = [];
      if (toLabel.displayName !== fromLabel.displayName) changes.push("displayName");
      if (toLabel.description !== fromLabel.description) changes.push("description");
      const fromKeys = [...(fromLabel.naturalKeyProps ?? [])].sort().join(",");
      const toKeys = [...(toLabel.naturalKeyProps ?? [])].sort().join(",");
      if (fromKeys !== toKeys) changes.push("naturalKeyProps");
      if (changes.length > 0) labelsChanged.push({ schemaName: sn, labelName: ln, changes });
    }
  }
  for (const [key] of fromLabelMap) {
    if (!toLabelMap.has(key)) {
      const [sn, ln] = key.split(":");
      if (sn && ln) labelsRemoved.push({ schemaName: sn, labelName: ln });
    }
  }

  // ── Relationship type diff ───────────────────────────────────────────────────

  const fromRelMap = new Map(
    fromRels.map((r) => [`${schemaNameMap.get(r.schemaId) ?? ""}:${r.name}`, r]),
  );
  const toRelMap = new Map(
    toRels.map((r) => [`${schemaNameMap.get(r.schemaId) ?? ""}:${r.name}`, r]),
  );

  const relationshipTypesAdded: Array<{ schemaName: string; relationshipTypeName: string }> = [];
  const relationshipTypesRemoved: Array<{ schemaName: string; relationshipTypeName: string }> = [];
  const relationshipTypesChanged: Array<{
    schemaName: string;
    relationshipTypeName: string;
    changes: string[];
  }> = [];

  for (const [key, toRel] of toRelMap) {
    const fromRel = fromRelMap.get(key);
    const [sn, rn] = key.split(":");
    if (!sn || !rn) continue;
    if (!fromRel) {
      relationshipTypesAdded.push({ schemaName: sn, relationshipTypeName: rn });
    } else {
      const changes: string[] = [];
      if (toRel.displayName !== fromRel.displayName) changes.push("displayName");
      if (toRel.startLabel !== fromRel.startLabel) changes.push("startLabel");
      if (toRel.endLabel !== fromRel.endLabel) changes.push("endLabel");
      if (toRel.cardinality !== fromRel.cardinality) changes.push("cardinality");
      if (changes.length > 0)
        relationshipTypesChanged.push({ schemaName: sn, relationshipTypeName: rn, changes });
    }
  }
  for (const [key] of fromRelMap) {
    if (!toRelMap.has(key)) {
      const [sn, rn] = key.split(":");
      if (sn && rn) relationshipTypesRemoved.push({ schemaName: sn, relationshipTypeName: rn });
    }
  }

  // ── Property diff ────────────────────────────────────────────────────────────

  // Build label+rel name lookup by id
  const labelNameById = new Map([
    ...fromLabels.map((l) => [l.id, l.name] as [string, string]),
    ...toLabels.map((l) => [l.id, l.name] as [string, string]),
  ]);
  const relNameById = new Map([
    ...fromRels.map((r) => [r.id, r.name] as [string, string]),
    ...toRels.map((r) => [r.id, r.name] as [string, string]),
  ]);

  const propOwnerName = (p: PropRow): string => {
    if (p.nodeLabelId) return labelNameById.get(p.nodeLabelId) ?? p.nodeLabelId;
    if (p.relationshipTypeId) return relNameById.get(p.relationshipTypeId) ?? p.relationshipTypeId;
    return "unknown";
  };

  const fromPropMap = new Map(
    fromProps.map((p) => [`${propOwnerName(p)}:${p.key}`, p]),
  );
  const toPropMap = new Map(
    toProps.map((p) => [`${propOwnerName(p)}:${p.key}`, p]),
  );

  const propertiesAdded: Array<{ ownerName: string; key: string }> = [];
  const propertiesRemoved: Array<{ ownerName: string; key: string }> = [];
  const propertiesChanged: Array<{ ownerName: string; key: string; changes: string[] }> = [];

  for (const [key, toProp] of toPropMap) {
    const fromProp = fromPropMap.get(key);
    const [on, pk] = key.split(":");
    if (!on || !pk) continue;
    if (!fromProp) {
      propertiesAdded.push({ ownerName: on, key: pk });
    } else {
      const changes: string[] = [];
      if (toProp.dataType !== fromProp.dataType) changes.push("dataType");
      if (toProp.required !== fromProp.required) changes.push("required");
      if (toProp.description !== fromProp.description) changes.push("description");
      if (changes.length > 0) propertiesChanged.push({ ownerName: on, key: pk, changes });
    }
  }
  for (const [key] of fromPropMap) {
    if (!toPropMap.has(key)) {
      const [on, pk] = key.split(":");
      if (on && pk) propertiesRemoved.push({ ownerName: on, key: pk });
    }
  }

  logger.info(
    { fromVersionId, toVersionId, schemasAdded: schemasAdded.length },
    "schema.version.diff: computed diff",
  );

  return {
    schemasAdded,
    schemasRemoved,
    labelsAdded,
    labelsRemoved,
    labelsChanged,
    relationshipTypesAdded,
    relationshipTypesRemoved,
    relationshipTypesChanged,
    propertiesAdded,
    propertiesRemoved,
    propertiesChanged,
  };
};
