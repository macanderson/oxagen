import type {
  TenantSlugs,
  SchemaRegistryData,
  SchemaItem,
  PropertyItem,
  VersionItem,
  VersionDiff,
} from "./types";

/**
 * The live app hits the real `/api/schema/*` route; Storybook has no API
 * backend, so every service call there would `fetch` a route that 404s inside
 * the preview iframe. When running under Storybook we serve the in-memory
 * fixtures instead. `apps/app/.storybook/preview.ts` sets the global flag.
 *
 * Read at call time (not module load) so the result is correct regardless of
 * whether Storybook evaluates `preview.ts` before or after the story modules
 * that import this service.
 */
function fixturesEnabled(): boolean {
  return (
    (globalThis as { __OXAGEN_STORYBOOK__?: boolean }).__OXAGEN_STORYBOOK__ ===
    true
  );
}

// ---- Input / Output type aliases ----

export type SchemaRegistryGetOutput = SchemaRegistryData;

export interface SchemaListOutput {
  schemas: Array<
    Pick<
      SchemaItem,
      "schemaName" | "displayName" | "source" | "connectorId" | "enabled"
    >
  >;
}

export interface SchemaToggleOutput {
  schemaName: string;
  enabled: boolean;
  publishedVersionId: string | null;
  pinnedVersionId: string | null;
  isDowngrade: boolean;
  reconcileRecommended: boolean;
}

export interface SchemaLabelUpsertInput {
  schemaName: string;
  name: string;
  displayName: string;
  description?: string;
  naturalKeyProps?: string[];
  properties?: PropertyItem[];
}

export interface SchemaLabelUpsertOutput {
  labelId: string;
  created: boolean;
}

export interface SchemaRelationshipUpsertInput {
  schemaName: string;
  name: string;
  displayName: string;
  startLabel?: string;
  endLabel?: string;
  cardinality?: "one_to_one" | "one_to_many" | "many_to_many";
  description?: string;
  properties?: PropertyItem[];
}

export interface SchemaRelationshipUpsertOutput {
  relationshipTypeId: string;
  created: boolean;
}

export interface SchemaPropertyUpsertInput {
  ownerKind: "node" | "relationship";
  ownerName: string;
  key: string;
  dataType: PropertyItem["dataType"];
  required: boolean;
  description?: string;
  enumValues?: string[];
  itemType?: string;
  constraints?: PropertyItem["constraints"];
  example?: string;
}

export interface SchemaPropertyUpsertOutput {
  propertyId: string;
  created: boolean;
}

export interface SchemaLabelDeleteOutput {
  deleted: boolean;
  labelName: string;
}

export interface SchemaRelationshipDeleteOutput {
  deleted: boolean;
  relationshipTypeName: string;
}

export interface SchemaPropertyDeleteOutput {
  deleted: boolean;
  propertyKey: string;
}

export interface SchemaVersionListOutput {
  versions: VersionItem[];
  total: number;
}

export type SchemaVersionDiffOutput = VersionDiff;

export interface SchemaExportOutput {
  assetId: string;
  serveUrl: string;
  versionId: string;
  versionNumber: number;
}

export interface SchemaRecommendOutput {
  proposal: {
    schemas: Array<{
      name: string;
      displayName: string;
      labels: Array<{
        name: string;
        description?: string;
        properties?: Array<{
          key: string;
          dataType: PropertyItem["dataType"];
          required: boolean;
          description?: string;
        }>;
      }>;
      relationshipTypes: Array<{
        name: string;
        startLabel?: string;
        endLabel?: string;
        description?: string;
      }>;
    }>;
  };
  rationale: string;
  sampledCount: number;
}

export interface SchemaReconcileDispatchOutput {
  executionId: string;
}

export interface SchemaRegistryConfigInput {
  enforcementMode?: "strict" | "lenient" | "off";
  conformanceFloor?: number;
}

export interface SchemaRegistryConfigOutput {
  registryId: string;
  enforcementMode: "strict" | "lenient" | "off";
  conformanceFloor: number;
}

// ---- Fixture data ----

const FIXTURE_REGISTRY: SchemaRegistryData = {
  registryId: "reg_fixture_01",
  pinnedVersionId: "ver_01",
  draftVersionId: "ver_02",
  enforcementMode: "lenient",
  conformanceFloor: 0.8,
  schemas: [
    {
      schemaName: "core",
      displayName: "Core",
      source: "recommended",
      enabled: true,
      labels: [
        {
          name: "Person",
          displayName: "Person",
          description: "A human individual",
          properties: [
            {
              key: "name",
              dataType: "string",
              required: true,
              description: "Full name",
            },
            { key: "email", dataType: "email", required: false },
          ],
        },
        {
          name: "Organization",
          displayName: "Organization",
          description: "A company or institution",
          properties: [
            { key: "name", dataType: "string", required: true },
            { key: "industry", dataType: "string", required: false },
          ],
        },
      ],
      relationshipTypes: [
        {
          name: "WORKS_FOR",
          displayName: "Works For",
          startLabel: "Person",
          endLabel: "Organization",
        },
        {
          name: "KNOWS",
          displayName: "Knows",
          startLabel: "Person",
          endLabel: "Person",
        },
      ],
    },
    {
      schemaName: "github",
      displayName: "GitHub",
      source: "connector",
      connectorId: "conn_github_01",
      enabled: false,
      labels: [
        {
          name: "Repository",
          displayName: "Repository",
          properties: [
            { key: "name", dataType: "string", required: true },
            { key: "url", dataType: "url", required: false },
          ],
        },
      ],
      relationshipTypes: [
        {
          name: "OWNS",
          displayName: "Owns",
          startLabel: "Organization",
          endLabel: "Repository",
        },
      ],
    },
  ],
};

const FIXTURE_VERSIONS: VersionItem[] = [
  {
    versionId: "ver_01",
    versionNumber: 1,
    status: "published",
    label: "Initial schema",
    changeSummary: "Created core schema with Person, Organization, WORKS_FOR.",
    publishedAt: "2026-06-01T10:00:00Z",
    isPinned: true,
  },
  {
    versionId: "ver_02",
    versionNumber: 2,
    status: "draft",
    label: null,
    changeSummary: null,
    publishedAt: null,
    isPinned: false,
  },
];

const FIXTURE_DIFF: VersionDiff = {
  schemasAdded: [],
  schemasRemoved: [],
  labelsAdded: [{ schemaName: "core", labelName: "Contract" }],
  labelsRemoved: [],
  labelsChanged: [
    {
      schemaName: "core",
      labelName: "Person",
      changes: ["Added property: email"],
    },
  ],
  relationshipTypesAdded: [],
  relationshipTypesRemoved: [],
  relationshipTypesChanged: [],
  propertiesAdded: [{ ownerName: "Person", key: "phone" }],
  propertiesRemoved: [],
  propertiesChanged: [],
};

const FIXTURE_RECOMMEND: SchemaRecommendOutput = {
  proposal: {
    schemas: [
      {
        name: "recommended",
        displayName: "Recommended",
        labels: [
          {
            name: "Contact",
            description: "A contact in the workspace",
            properties: [
              { key: "name", dataType: "string", required: true },
              { key: "email", dataType: "email", required: false },
            ],
          },
          {
            name: "Deal",
            description: "A sales deal",
            properties: [
              { key: "title", dataType: "string", required: true },
              { key: "value", dataType: "number", required: false },
            ],
          },
        ],
        relationshipTypes: [
          {
            name: "INVOLVED_IN",
            startLabel: "Contact",
            endLabel: "Deal",
          },
        ],
      },
    ],
  },
  rationale:
    "Based on 180 sampled graph nodes, your workspace contains contacts and deal-like entities. A CRM-style schema would best capture existing relationships.",
  sampledCount: 180,
};

// ---- HTTP helpers ----

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/schema/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = j.error;
    } catch {
      // keep the status-based default
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

// ---- Service functions ----

export async function fetchRegistry(
  slugs: TenantSlugs,
  opts: { versionId?: string } = {},
): Promise<SchemaRegistryGetOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return FIXTURE_REGISTRY;
  }
  return post<SchemaRegistryGetOutput>("registry/get", { ...slugs, ...opts });
}

export async function fetchSchemas(
  slugs: TenantSlugs,
): Promise<SchemaListOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return {
      schemas: FIXTURE_REGISTRY.schemas.map(
        ({ schemaName, displayName, source, connectorId, enabled }) => ({
          schemaName,
          displayName,
          source,
          connectorId,
          enabled,
        }),
      ),
    };
  }
  return post<SchemaListOutput>("list", { ...slugs });
}

export async function toggleSchema(
  slugs: TenantSlugs,
  schemaName: string,
  enabled: boolean,
): Promise<SchemaToggleOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return {
      schemaName,
      enabled,
      publishedVersionId: enabled ? "ver_03" : null,
      pinnedVersionId: enabled ? "ver_03" : null,
      isDowngrade: false,
      reconcileRecommended: enabled,
    };
  }
  return post<SchemaToggleOutput>("toggle", { ...slugs, schemaName, enabled });
}

export async function upsertLabel(
  slugs: TenantSlugs,
  input: SchemaLabelUpsertInput,
): Promise<SchemaLabelUpsertOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return { labelId: `lbl_${input.name}`, created: true };
  }
  return post<SchemaLabelUpsertOutput>("label/upsert", { ...slugs, ...input });
}

export async function upsertRelationship(
  slugs: TenantSlugs,
  input: SchemaRelationshipUpsertInput,
): Promise<SchemaRelationshipUpsertOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return { relationshipTypeId: `rel_${input.name}`, created: true };
  }
  return post<SchemaRelationshipUpsertOutput>("relationship/upsert", {
    ...slugs,
    ...input,
  });
}

export async function upsertProperty(
  slugs: TenantSlugs,
  input: SchemaPropertyUpsertInput,
): Promise<SchemaPropertyUpsertOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return { propertyId: `prop_${input.key}`, created: true };
  }
  return post<SchemaPropertyUpsertOutput>("property/upsert", {
    ...slugs,
    ...input,
  });
}

export async function deleteLabel(
  slugs: TenantSlugs,
  schemaName: string,
  labelName: string,
): Promise<SchemaLabelDeleteOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return { deleted: true, labelName };
  }
  return post<SchemaLabelDeleteOutput>("label/delete", {
    ...slugs,
    schemaName,
    name: labelName,
  });
}

export async function deleteRelationship(
  slugs: TenantSlugs,
  schemaName: string,
  name: string,
): Promise<SchemaRelationshipDeleteOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return { deleted: true, relationshipTypeName: name };
  }
  return post<SchemaRelationshipDeleteOutput>("relationship/delete", {
    ...slugs,
    schemaName,
    name,
  });
}

export async function deleteProperty(
  slugs: TenantSlugs,
  ownerName: string,
  key: string,
): Promise<SchemaPropertyDeleteOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return { deleted: true, propertyKey: key };
  }
  return post<SchemaPropertyDeleteOutput>("property/delete", {
    ...slugs,
    ownerName,
    key,
  });
}

export async function fetchVersions(
  slugs: TenantSlugs,
  opts: { limit?: number; offset?: number } = {},
): Promise<SchemaVersionListOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return { versions: FIXTURE_VERSIONS, total: FIXTURE_VERSIONS.length };
  }
  return post<SchemaVersionListOutput>("version/list", { ...slugs, ...opts });
}

export async function diffVersions(
  slugs: TenantSlugs,
  fromVersionId: string,
  toVersionId: string,
): Promise<SchemaVersionDiffOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return FIXTURE_DIFF;
  }
  return post<SchemaVersionDiffOutput>("version/diff", {
    ...slugs,
    fromVersionId,
    toVersionId,
  });
}

export async function exportSchema(
  slugs: TenantSlugs,
  opts: { versionId?: string } = {},
): Promise<SchemaExportOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return {
      assetId: "ast_fixture_01",
      serveUrl: "#",
      versionId: "ver_01",
      versionNumber: 1,
    };
  }
  return post<SchemaExportOutput>("export", { ...slugs, ...opts });
}

export async function recommend(
  slugs: TenantSlugs,
  opts: { sampleLimit?: number } = {},
): Promise<SchemaRecommendOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return FIXTURE_RECOMMEND;
  }
  return post<SchemaRecommendOutput>("recommend", { ...slugs, ...opts });
}

export async function reconcileDispatch(
  slugs: TenantSlugs,
  versionId: string,
  prune: boolean,
): Promise<SchemaReconcileDispatchOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return { executionId: "aex_fixture_01" };
  }
  return post<SchemaReconcileDispatchOutput>("reconcile/dispatch", {
    ...slugs,
    versionId,
    prune,
  });
}

export async function configRegistry(
  slugs: TenantSlugs,
  input: SchemaRegistryConfigInput,
): Promise<SchemaRegistryConfigOutput> {
  if (fixturesEnabled()) {
    await delay(300);
    return {
      registryId: "reg_fixture_01",
      enforcementMode: input.enforcementMode ?? "lenient",
      conformanceFloor: input.conformanceFloor ?? 0.8,
    };
  }
  return post<SchemaRegistryConfigOutput>("registry/config", {
    ...slugs,
    ...input,
  });
}

export interface SchemaChatOutput {
  assistantMessage: string;
  proposedMutations?: Array<{
    capability: string;
    input: Record<string, unknown>;
  }>;
  conversationId: string;
}

export async function schemaChat(
  slugs: TenantSlugs,
  message: string,
): Promise<SchemaChatOutput> {
  return post<SchemaChatOutput>("chat", { ...slugs, message });
}

/**
 * Apply one chat-proposed mutation by POSTing it to the schema proxy route.
 *
 * `capability` is written by the model behind `schemaChat`, so it is untrusted
 * input that ends up in a URL. Today the handler emits ADR-025 verb-first
 * snake_case names ("upsert_schema_label"); the dot→slash step is kept only so
 * a legacy dotted name ("schema.label.upsert" → "label/upsert") still resolves
 * against the route's path map. Anything that could escape /api/schema/ — a
 * traversal segment or a leading slash — is rejected before the fetch; the
 * route allow-lists capability names again on its own side.
 */
export async function applyMutation(
  slugs: TenantSlugs,
  capability: string,
  input: unknown,
): Promise<unknown> {
  const path = capability.replace(/^schema\./, "").replace(/\./g, "/");
  if (!/^[a-z0-9_]+(\/[a-z0-9_]+)*$/i.test(path)) {
    throw new Error(
      `Refusing to apply an unrecognized mutation: ${capability}`,
    );
  }
  return post(path, { ...slugs, ...(input as Record<string, unknown>) });
}
