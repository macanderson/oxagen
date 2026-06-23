import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaChat } from "@oxagen/oxagen/contracts/schema.chat";
import { generateObjectFor } from "@oxagen/ai";
import { z } from "zod";
import { logger } from "./logger";

// Structured output. The model fills a TYPED ontology for creation (reliable —
// every label/relationship carries its identity fields) plus a free-form
// `mutations` list for targeted edits/deletes/toggles. The handler converts
// both into contract-valid proposedMutations, so a probabilistic model can't
// emit a half-formed mutation that fails validation at apply time.
const propertyShape = z.object({
  key: z.string(),
  dataType: z.string().describe("string|number|integer|boolean|date|datetime|url|email|enum|json|array"),
  required: z.boolean().optional(),
  description: z.string().optional(),
});

const labelShape = z.object({
  name: z.string().describe("PascalCase node label, e.g. Customer"),
  displayName: z.string().optional(),
  description: z.string().optional(),
  properties: z.array(propertyShape).optional(),
});

const relationshipShape = z.object({
  name: z.string().describe("UPPER_SNAKE relationship type, e.g. SIGNED_CONTRACT"),
  displayName: z.string().optional(),
  description: z.string().optional(),
  startLabel: z.string().optional(),
  endLabel: z.string().optional(),
  cardinality: z.string().optional().describe("one_to_one | one_to_many | many_to_many"),
  properties: z.array(propertyShape).optional(),
});

const chatResponseSchema = z.object({
  assistantMessage: z.string().describe("Explain what you propose and why"),
  schemas: z
    .array(
      z.object({
        name: z.string().describe("snake_case schema group name, e.g. customer, billing"),
        displayName: z.string().optional(),
        description: z.string().optional(),
        labels: z.array(labelShape).optional(),
        relationshipTypes: z.array(relationshipShape).optional(),
      }),
    )
    .optional()
    .describe("Named schema groups to CREATE/UPDATE (scaffolding)"),
  mutations: z
    .array(
      z.object({
        capability: z.string().describe("e.g. schema.label.delete, schema.property.upsert, schema.toggle"),
        input: z.record(z.string(), z.unknown()),
      }),
    )
    .optional()
    .describe("Targeted edits/deletes/toggles that don't fit the schemas scaffold"),
});

export const schemaChatHandler: CapabilityHandler<typeof schemaChat> = async (input, ctx) => {
  const conversationId = input.conversationId ?? crypto.randomUUID();

  const system = `You are an expert knowledge graph schema designer for a workspace schema registry. You speak the canonical Neo4j vocabulary: node labels, relationship types, properties.

Return your answer in TWO parts:

1. \`schemas\`: named schema groups to create or extend. Use this for any request that adds labels/relationship types. For a broad request (e.g. "generate schemas for a B2B SaaS business") produce MULTIPLE schema groups, each a distinct business domain, for example:
   - customer: Customer, Organization, Contact
   - subscription: Subscription, Plan, Feature
   - billing: Invoice, Payment
   - sales: Lead, Deal, Opportunity, Competitor
   - support: SupportTicket, Bug, ProductFeature
   - people: Employee, Vendor, Partner
   Every label needs a PascalCase \`name\`, a \`displayName\`, and typed \`properties\` (each with \`key\`, \`dataType\` from string|number|integer|boolean|date|datetime|url|email|enum|json|array, and \`required\`). Every relationship type needs an UPPER_SNAKE \`name\`, a \`displayName\`, \`startLabel\`, \`endLabel\`, and \`cardinality\` (one_to_one | one_to_many | many_to_many — never "many_to_one" or uppercase).

2. \`mutations\`: ONLY for targeted edits/removals/toggles that don't fit a scaffold — e.g. delete a label (schema.label.delete with {schemaName, name}), add one property (schema.property.upsert with {schemaName, ownerKind, ownerName, key, dataType, required}), or enable/disable a schema (schema.toggle with {schemaName, enabled}).

ADDITIVE rule: you are editing the EXISTING draft. Never wipe prior work; only add or change what the user asked for. Always explain your changes in \`assistantMessage\`.

Conversation ID: ${conversationId}
Draft version: ${input.draftVersionId ?? "current draft"}`;

  const { object } = await generateObjectFor({
    schema: chatResponseSchema,
    prompt: input.message,
    system,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      messageId: ctx.messageId ?? null,
    },
  });

  const proposedMutations = buildProposedMutations(object);

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      conversationId,
      mutationCount: proposedMutations.length,
    },
    "schema.chat: generated response",
  );

  return {
    assistantMessage: object.assistantMessage,
    proposedMutations,
    conversationId,
  };
};

// ── Conversion + normalization ─────────────────────────────────────────────

const VALID_CARDINALITY = new Set(["one_to_one", "one_to_many", "many_to_many"]);
const DATA_TYPE_SYNONYMS: Record<string, string> = {
  text: "string", str: "string", varchar: "string", uuid: "string",
  int: "integer", bigint: "integer", long: "integer",
  float: "number", double: "number", decimal: "number",
  bool: "boolean", timestamp: "datetime", time: "datetime",
  object: "json", map: "json", list: "array",
};
const VALID_DATA_TYPES = new Set([
  "string", "number", "integer", "boolean", "date", "datetime", "url", "email", "enum", "json", "array",
]);

type Mutation = { capability: string; input: Record<string, unknown> };

function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeDataType(dt: unknown): string {
  const v = String(dt ?? "string").toLowerCase();
  if (VALID_DATA_TYPES.has(v)) return v;
  return DATA_TYPE_SYNONYMS[v] ?? "string";
}

function normalizeProperty(p: Record<string, unknown>): Record<string, unknown> {
  return {
    ...p,
    key: typeof p.key === "string" ? p.key.trim() : p.key,
    dataType: normalizeDataType(p.dataType),
    required: typeof p.required === "boolean" ? p.required : false,
  };
}

function normalizeRelName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);
}

function normalizeCardinality(c: unknown): string | undefined {
  if (c == null) return undefined;
  let v = String(c).toLowerCase();
  if (v === "many_to_one") v = "one_to_many";
  return VALID_CARDINALITY.has(v) ? v : undefined;
}

function buildProposedMutations(object: z.infer<typeof chatResponseSchema>): Mutation[] {
  const out: Mutation[] = [];

  for (const schema of object.schemas ?? []) {
    const schemaName = (schema.name ?? "").trim();
    if (!schemaName) continue;
    for (const label of schema.labels ?? []) {
      if (!label.name) continue;
      out.push({
        capability: "schema.label.upsert",
        input: {
          schemaName,
          name: label.name,
          displayName: label.displayName || humanize(label.name),
          ...(label.description ? { description: label.description } : {}),
          ...(label.properties?.length
            ? { properties: label.properties.map(normalizeProperty) }
            : {}),
        },
      });
    }
    for (const rel of schema.relationshipTypes ?? []) {
      if (!rel.name) continue;
      const cardinality = normalizeCardinality(rel.cardinality);
      out.push({
        capability: "schema.relationship.upsert",
        input: {
          schemaName,
          name: normalizeRelName(rel.name),
          displayName: rel.displayName || humanize(rel.name),
          ...(rel.startLabel ? { startLabel: rel.startLabel } : {}),
          ...(rel.endLabel ? { endLabel: rel.endLabel } : {}),
          ...(cardinality ? { cardinality } : {}),
          ...(rel.description ? { description: rel.description } : {}),
          ...(rel.properties?.length
            ? { properties: rel.properties.map(normalizeProperty) }
            : {}),
        },
      });
    }
  }

  // Pass through targeted edits/deletes, dropping anything missing its identity.
  for (const m of object.mutations ?? []) {
    const input: Record<string, unknown> = { ...m.input };
    const cap = m.capability;
    if (cap === "schema.label.upsert" || cap === "schema.label.delete") {
      if (!input.name || !input.schemaName) continue;
      if (cap === "schema.label.upsert" && !input.displayName) input.displayName = humanize(String(input.name));
    } else if (cap === "schema.relationship.upsert" || cap === "schema.relationship.delete") {
      if (!input.name || !input.schemaName) continue;
      input.name = normalizeRelName(String(input.name));
      if (cap === "schema.relationship.upsert") {
        if (!input.displayName) input.displayName = humanize(String(input.name));
        const c = normalizeCardinality(input.cardinality);
        if (c) input.cardinality = c; else delete input.cardinality;
      }
    } else if (cap === "schema.property.upsert") {
      if (!input.ownerName || !input.key || !input.schemaName) continue;
      if (!input.ownerKind) input.ownerKind = "node";
      input.dataType = normalizeDataType(input.dataType);
      if (typeof input.required !== "boolean") input.required = false;
    } else if (cap === "schema.property.delete") {
      if (!input.ownerName || !input.key) continue;
    } else if (cap === "schema.toggle") {
      if (!input.schemaName || typeof input.enabled !== "boolean") continue;
    }
    out.push({ capability: cap, input });
  }

  return out;
}
