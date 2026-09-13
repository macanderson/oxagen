/**
 * types.ts — local TypeScript interfaces mirroring the schema contract output shapes.
 * No Zod — just TS interfaces for the schema-builder UI.
 */

export interface TenantSlugs {
  orgSlug: string;
  workspaceSlug: string;
}

export interface PropertyItem {
  key: string;
  dataType:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "date"
    | "datetime"
    | "url"
    | "email"
    | "enum"
    | "json"
    | "array";
  required: boolean;
  description?: string;
  enumValues?: string[];
  itemType?: string;
  constraints?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
  example?: string;
}

export interface LabelItem {
  name: string;
  displayName: string;
  description?: string | null;
  naturalKeyProps?: string[];
  properties?: PropertyItem[];
}

export interface RelationshipItem {
  name: string;
  displayName: string;
  startLabel?: string | null;
  endLabel?: string | null;
  cardinality?: "one_to_one" | "one_to_many" | "many_to_many";
  description?: string | null;
  properties?: PropertyItem[];
}

export interface SchemaItem {
  schemaName: string;
  displayName: string;
  source: "user" | "connector" | "recommended";
  connectorId?: string | null;
  enabled: boolean;
  labels: LabelItem[];
  relationshipTypes: RelationshipItem[];
}

export interface VersionItem {
  versionId: string;
  versionNumber: number;
  status: "draft" | "published";
  label: string | null;
  changeSummary: string | null;
  publishedAt: string | null;
  isPinned: boolean;
}

export interface VersionDiff {
  schemasAdded: string[];
  schemasRemoved: string[];
  labelsAdded: Array<{ schemaName: string; labelName: string }>;
  labelsRemoved: Array<{ schemaName: string; labelName: string }>;
  labelsChanged: Array<{
    schemaName: string;
    labelName: string;
    changes: string[];
  }>;
  relationshipTypesAdded: Array<{
    schemaName: string;
    relationshipTypeName: string;
  }>;
  relationshipTypesRemoved: Array<{
    schemaName: string;
    relationshipTypeName: string;
  }>;
  relationshipTypesChanged: Array<{
    schemaName: string;
    relationshipTypeName: string;
    changes: string[];
  }>;
  propertiesAdded: Array<{ ownerName: string; key: string }>;
  propertiesRemoved: Array<{ ownerName: string; key: string }>;
  propertiesChanged: Array<{
    ownerName: string;
    key: string;
    changes: string[];
  }>;
}

export interface SchemaRegistryData {
  registryId: string;
  pinnedVersionId: string | null;
  draftVersionId: string | null;
  enforcementMode: "strict" | "lenient" | "off";
  conformanceFloor: number;
  schemas: SchemaItem[];
}
