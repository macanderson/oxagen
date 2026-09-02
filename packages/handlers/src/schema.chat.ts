import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaChat } from "@oxagen/oxagen/contracts/schema.chat";
import { generateObjectFor, selectModel } from "@oxagen/ai";
import { z } from "zod";
import { schema as db, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

interface DraftSchema {
  name: string;
  labels: string[];
  rels: string[];
}

// Compact summary of the current draft so the model edits additively against
// the real schema/label/relationship names instead of guessing (drops, property
// adds, and "don't wipe prior work" all depend on this grounding). Returns both
// the prompt text AND the structured schemas, which the deterministic intent
// layer matches against.
async function loadDraft(
  orgId: string,
  workspaceId: string,
  userId: string | null,
): Promise<{ text: string; schemas: DraftSchema[] }> {
  const registry = await getOrCreateRegistry(orgId, workspaceId, userId);
  const empty = {
    text: "The registry draft is currently EMPTY (no schemas yet).",
    schemas: [] as DraftSchema[],
  };
  if (!registry.draftVersionId) return empty;
  const draftVersionId = registry.draftVersionId;
  return withTenantDb(async (tx) => {
    const schemaRows = await tx
      .select({ id: db.schemas.id, name: db.schemas.name })
      .from(db.schemas)
      .where(
        and(
          eq(db.schemas.versionId, draftVersionId),
          isNull(db.schemas.deletedAt),
        ),
      );
    if (schemaRows.length === 0) return empty;
    const labels = await tx
      .select({ schemaId: db.nodeLabels.schemaId, name: db.nodeLabels.name })
      .from(db.nodeLabels)
      .where(
        and(
          eq(db.nodeLabels.versionId, draftVersionId),
          isNull(db.nodeLabels.deletedAt),
        ),
      );
    const rels = await tx
      .select({
        schemaId: db.relationshipTypes.schemaId,
        name: db.relationshipTypes.name,
      })
      .from(db.relationshipTypes)
      .where(
        and(
          eq(db.relationshipTypes.versionId, draftVersionId),
          isNull(db.relationshipTypes.deletedAt),
        ),
      );
    const bySchema = new Map(
      schemaRows.map((s) => [
        s.id,
        { name: s.name, labels: [] as string[], rels: [] as string[] },
      ]),
    );
    for (const l of labels) bySchema.get(l.schemaId)?.labels.push(l.name);
    for (const r of rels) bySchema.get(r.schemaId)?.rels.push(r.name);
    const schemas = [...bySchema.values()];
    const lines = schemas.map(
      (s) =>
        `- schema "${s.name}": labels [${s.labels.join(", ") || "none"}]; relationshipTypes [${s.rels.join(", ") || "none"}]`,
    );
    return {
      text: `Current draft schemas (edit these additively — use these EXACT names):\n${lines.join("\n")}`,
      schemas,
    };
  });
}

// Structured output. The model fills a TYPED ontology for creation (reliable —
// every label/relationship carries its identity fields) plus a free-form
// `mutations` list for targeted edits/deletes/toggles. The handler converts
// both into contract-valid proposedMutations, so a probabilistic model can't
// emit a half-formed mutation that fails validation at apply time.
const propertyShape = z.object({
  key: z.string(),
  dataType: z
    .string()
    .describe(
      "string|number|integer|boolean|date|datetime|url|email|enum|json|array",
    ),
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
  name: z
    .string()
    .describe("UPPER_SNAKE relationship type, e.g. SIGNED_CONTRACT"),
  displayName: z.string().optional(),
  description: z.string().optional(),
  startLabel: z.string().optional(),
  endLabel: z.string().optional(),
  cardinality: z
    .string()
    .optional()
    .describe("one_to_one | one_to_many | many_to_many"),
  properties: z.array(propertyShape).optional(),
});

const chatResponseSchema = z.object({
  assistantMessage: z.string().describe("Explain what you propose and why"),
  schemas: z
    .array(
      z.object({
        name: z
          .string()
          .describe("snake_case schema group name, e.g. customer, billing"),
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
        capability: z
          .string()
          .describe(
            "e.g. delete_schema_label, upsert_schema_property, toggle_schema",
          ),
        input: z.record(z.string(), z.unknown()),
      }),
    )
    .optional()
    .describe(
      "Targeted edits/deletes/toggles that don't fit the schemas scaffold",
    ),
});

export const schemaChatHandler: CapabilityHandler<typeof schemaChat> = async (
  input,
  ctx,
) => {
  const conversationId = input.conversationId ?? crypto.randomUUID();
  const draft = await loadDraft(ctx.orgId, ctx.workspaceId, ctx.userId);

  // Deterministic intent layer: simple single-op edits (drop/disable/enable a
  // schema, add a property) are parsed straight to contract mutations, so they
  // NEVER depend on the probabilistic model choosing to populate `mutations`.
  // The LLM still handles open-ended/multi-step asks (e.g. "generate schemas
  // for a B2B SaaS company"). Both sets are merged + deduped below.
  const deterministicMutations = detectSimpleIntents(
    input.message,
    draft.schemas,
  );

  // Fast path: a clear single-op edit (drop/disable/enable/add-property) that is
  // NOT also a create/scaffold request is handled entirely by the deterministic
  // layer — skip the (slow, precise-tier) LLM call. Instant + 100% reliable.
  const wantsCreate =
    /\b(generate|scaffold|build|design)\b/i.test(input.message) ||
    // "add/create a LABEL or RELATIONSHIP" is a structural create (LLM path);
    // "add a FIELD/PROPERTY" is NOT — it's handled deterministically (fast path).
    /\b(create|add)\b.*\b(label|relationship|node type|ontolog)/i.test(
      input.message,
    ) ||
    /\bschemas?\b.*\b(for a|capturing|ontology of)\b/i.test(input.message);
  if (deterministicMutations.length > 0 && !wantsCreate) {
    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        conversationId,
        mutationCount: deterministicMutations.length,
      },
      "schema.chat: deterministic fast-path",
    );
    return {
      assistantMessage: describeMutations(deterministicMutations),
      proposedMutations: deterministicMutations,
      conversationId,
    };
  }

  const system = `You are an expert knowledge graph schema designer for a workspace schema registry. You speak the canonical Neo4j vocabulary: node labels, relationship types, properties.

${draft.text}

CRITICAL EXECUTION RULE: You are an EXECUTOR, not an advisor. When the user asks to drop / delete / remove / rename / add / change / enable / disable anything, you MUST emit the mutation(s) that perform it in this same response. NEVER reply with only an acknowledgement or a question. Use the EXACT existing names from the draft summary above. Worked examples:
- "drop the support schema" -> mutations: [{ "capability": "delete_schema", "input": { "schemaName": "support" } }]
- "add a number_of_licenses field to the subscriptions schema" -> mutations: [{ "capability": "upsert_schema_property", "input": { "schemaName": "subscription", "ownerKind": "node", "ownerName": "Subscription", "key": "number_of_licenses", "dataType": "integer", "required": false } }]
- "disable the billing schema" -> mutations: [{ "capability": "toggle_schema", "input": { "schemaName": "billing", "enabled": false } }]


Return your answer in TWO parts:

1. \`schemas\`: named schema groups to create or extend. Use this for any request that adds labels/relationship types. For a broad request (e.g. "generate schemas for a B2B SaaS business") produce MULTIPLE schema groups, each a distinct business domain, for example:
   - customer: Customer, Organization, Contact
   - subscription: Subscription, Plan, Feature
   - billing: Invoice, Payment
   - sales: Lead, Deal, Opportunity, Competitor
   - support: SupportTicket, Bug, ProductFeature
   - people: Employee, Vendor, Partner
   Every label needs a PascalCase \`name\`, a \`displayName\`, and typed \`properties\` (each with \`key\`, \`dataType\` from string|number|integer|boolean|date|datetime|url|email|enum|json|array, and \`required\`). Every relationship type needs an UPPER_SNAKE \`name\`, a \`displayName\`, \`startLabel\`, \`endLabel\`, and \`cardinality\` (one_to_one | one_to_many | many_to_many — never "many_to_one" or uppercase).

2. \`mutations\`: ONLY for targeted edits/removals/toggles that don't fit a scaffold — e.g. drop an entire schema (schema.delete with {schemaName}), delete one label (schema.label.delete with {schemaName, name}), add one property (schema.property.upsert with {schemaName, ownerKind, ownerName, key, dataType, required}), or enable/disable a schema (schema.toggle with {schemaName, enabled}). When the user asks to "drop" / "remove" / "delete" a whole schema, use schema.delete with just its {schemaName}.

ADDITIVE rule: you are editing the EXISTING draft. Never wipe prior work; only add or change what the user asked for. Always explain your changes in \`assistantMessage\`.

Conversation ID: ${conversationId}
Draft version: ${input.draftVersionId ?? "current draft"}`;

  const { object } = await generateObjectFor({
    schema: chatResponseSchema,
    prompt: input.message,
    system,
    // Precise tier (claude-opus-4.8): reliable structured tool/mutation emission
    // for schema authoring — the balanced default routinely under-emitted edits.
    model: selectModel({ tier: "precise" }),
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      messageId: ctx.messageId ?? null,
    },
  });

  // Deterministic mutations win (they're guaranteed-correct for the parsed
  // intent); the LLM's mutations + scaffold fill in the rest, deduped.
  const proposedMutations = dedupeMutations([
    ...deterministicMutations,
    ...buildProposedMutations(object),
  ]);

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      conversationId,
      deterministicCount: deterministicMutations.length,
      mutationCount: proposedMutations.length,
    },
    "schema.chat: generated response",
  );

  const assistantMessage =
    deterministicMutations.length > 0 && !object.assistantMessage
      ? `Applying ${deterministicMutations.length} change(s).`
      : object.assistantMessage;

  return {
    assistantMessage,
    proposedMutations,
    conversationId,
  };
};

// ── Conversion + normalization ─────────────────────────────────────────────

const VALID_CARDINALITY = new Set([
  "one_to_one",
  "one_to_many",
  "many_to_many",
]);
const DATA_TYPE_SYNONYMS: Record<string, string> = {
  text: "string",
  str: "string",
  varchar: "string",
  uuid: "string",
  int: "integer",
  bigint: "integer",
  long: "integer",
  float: "number",
  double: "number",
  decimal: "number",
  bool: "boolean",
  timestamp: "datetime",
  time: "datetime",
  object: "json",
  map: "json",
  list: "array",
};
const VALID_DATA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "url",
  "email",
  "enum",
  "json",
  "array",
]);

type Mutation = { capability: string; input: Record<string, unknown> };

/**
 * The only capabilities `mutations` may name — the registry-editing set the
 * system prompt documents. Keep this in sync with the normalization chain in
 * `buildProposedMutations`; a capability absent here is never proposed.
 */
const APPLICABLE_MUTATION_CAPABILITIES = new Set([
  "upsert_schema_label",
  "delete_schema_label",
  "upsert_schema_relationship",
  "delete_schema_relationship",
  "upsert_schema_property",
  "delete_schema_property",
  "delete_schema",
  "toggle_schema",
]);

// ── Deterministic intent layer ──────────────────────────────────────────────
// Maps clear single-op user intents to contract mutations without relying on
// the LLM. Conservative: only fires when an intent verb AND a real draft schema
// name are both present; otherwise returns [] and the LLM path handles it.

function singularize(w: string): string {
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ses")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Find a draft schema whose name is mentioned in the text (plural-tolerant). */
function matchSchema(
  text: string,
  schemas: DraftSchema[],
): DraftSchema | undefined {
  const words = text.toLowerCase().match(/[a-z][a-z0-9_]*/g) ?? [];
  const wordSet = new Set([...words, ...words.map(singularize)]);
  // Longest schema name first so "subscription" wins over a stray "sub".
  for (const s of [...schemas].sort((a, b) => b.name.length - a.name.length)) {
    const n = s.name.toLowerCase();
    if (wordSet.has(n) || wordSet.has(singularize(n))) return s;
  }
  return undefined;
}

/** Pick the label on a schema a property should attach to (prefer the one matching the schema name). */
function pickLabel(schema: DraftSchema): string | undefined {
  if (schema.labels.length === 0) return undefined;
  const sn = singularize(schema.name.toLowerCase());
  const match = schema.labels.find(
    (l) => l.toLowerCase() === sn || singularize(l.toLowerCase()) === sn,
  );
  return match ?? schema.labels[0];
}

/** Extract snake_case-ish field identifiers from the user's add-property message. */
function extractFieldNames(message: string): string[] {
  const stop = new Set([
    "schema",
    "schemas",
    "field",
    "fields",
    "property",
    "properties",
    "column",
    "columns",
    "attribute",
    "attributes",
  ]);
  const ids = message.match(/`?\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b`?/gi) ?? [];
  return [
    ...new Set(
      ids
        .map((s) => s.replace(/`/g, "").toLowerCase())
        .filter((s) => !stop.has(s)),
    ),
  ];
}

function inferDataType(key: string): string {
  const k = key.toLowerCase();
  if (/(^|_)(is|has|can|should)_|_flag$/.test(k)) return "boolean";
  if (/_at$|_date$|_since$|_on$|^date_|_day$/.test(k)) return "date";
  if (/_time$|_timestamp$|_datetime$/.test(k)) return "datetime";
  if (
    /^number_of_|_count$|_qty$|_quantity$|_licenses$|_seats$|_age$|_year$/.test(
      k,
    )
  )
    return "integer";
  if (/_amount$|_price$|_cost$|_total$|_rate$|_percent$|_score$/.test(k))
    return "number";
  if (/_email$|^email$/.test(k)) return "email";
  if (/_url$|_link$|^url$/.test(k)) return "url";
  return "string";
}

export function detectSimpleIntents(
  message: string,
  schemas: DraftSchema[],
): Mutation[] {
  if (schemas.length === 0) return [];
  const m = message.toLowerCase();
  const out: Mutation[] = [];

  // ADD PROPERTY — "add a number_of_licenses field to the subscriptions schema"
  if (/\badd\b/.test(m) && /\b(field|propert|column|attribute)/.test(m)) {
    const schema = matchSchema(m, schemas);
    const ownerName = schema && pickLabel(schema);
    const fields = extractFieldNames(message);
    if (schema && ownerName && fields.length > 0) {
      for (const key of fields) {
        out.push({
          capability: "upsert_schema_property",
          input: {
            schemaName: schema.name,
            ownerKind: "node",
            ownerName,
            key,
            dataType: inferDataType(key),
            required: false,
          },
        });
      }
      return out; // unambiguous add-property intent
    }
  }

  // DROP / DELETE / REMOVE a whole schema
  if (/\b(drop|delete|remove)\b/.test(m) && /\bschema\b/.test(m)) {
    const schema = matchSchema(m, schemas);
    if (schema)
      return [
        { capability: "delete_schema", input: { schemaName: schema.name } },
      ];
  }

  // DISABLE / DEACTIVATE / TURN OFF
  if (/\b(disable|deactivate|inactivate)\b|\bturn\s+off\b/.test(m)) {
    const schema = matchSchema(m, schemas);
    if (schema)
      return [
        {
          capability: "toggle_schema",
          input: { schemaName: schema.name, enabled: false },
        },
      ];
  }

  // ENABLE / ACTIVATE / TURN ON
  if (/\b(enable|activate)\b|\bturn\s+on\b/.test(m)) {
    const schema = matchSchema(m, schemas);
    if (schema)
      return [
        {
          capability: "toggle_schema",
          input: { schemaName: schema.name, enabled: true },
        },
      ];
  }

  return out;
}

/** Human-readable summary of fast-path mutations for the assistant reply. */
export function describeMutations(muts: Mutation[]): string {
  const parts: string[] = [];
  const props = muts.filter((m) => m.capability === "upsert_schema_property");
  if (props.length > 0) {
    const schemaName = props[0]?.input.schemaName;
    const keys = props.map((p) => `\`${String(p.input.key)}\``).join(", ");
    parts.push(
      `Added ${props.length} propert${props.length === 1 ? "y" : "ies"} (${keys}) to the ${schemaName} schema.`,
    );
  }
  for (const m of muts) {
    if (m.capability === "delete_schema")
      parts.push(`Dropped the ${m.input.schemaName} schema.`);
    else if (m.capability === "toggle_schema") {
      parts.push(
        `${m.input.enabled ? "Activated" : "Deactivated"} the ${m.input.schemaName} schema.`,
      );
    } else if (m.capability === "delete_schema_label")
      parts.push(
        `Removed the ${m.input.name} label from ${m.input.schemaName}.`,
      );
  }
  return parts.join(" ") || "Applied the requested change.";
}

/** Drop later duplicates of the same logical mutation (deterministic ones come first). */
export function dedupeMutations(muts: Mutation[]): Mutation[] {
  const seen = new Set<string>();
  const out: Mutation[] = [];
  for (const mu of muts) {
    const i = mu.input;
    const key = [mu.capability, i.schemaName, i.name, i.ownerName, i.key]
      .filter(Boolean)
      .join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mu);
  }
  return out;
}

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

function normalizeProperty(
  p: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...p,
    key: typeof p.key === "string" ? p.key.trim() : p.key,
    dataType: normalizeDataType(p.dataType),
    required: typeof p.required === "boolean" ? p.required : false,
  };
}

function normalizeRelName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 63);
}

function normalizeCardinality(c: unknown): string | undefined {
  if (c == null) return undefined;
  let v = String(c).toLowerCase();
  if (v === "many_to_one") v = "one_to_many";
  return VALID_CARDINALITY.has(v) ? v : undefined;
}

export function buildProposedMutations(
  object: z.infer<typeof chatResponseSchema>,
): Mutation[] {
  const out: Mutation[] = [];

  for (const schema of object.schemas ?? []) {
    const schemaName = (schema.name ?? "").trim();
    if (!schemaName) continue;
    for (const label of schema.labels ?? []) {
      if (!label.name) continue;
      out.push({
        capability: "upsert_schema_label",
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
        capability: "upsert_schema_relationship",
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
  // The capability is model-chosen text, and the schema-builder drawer applies
  // whatever comes back without asking the user first, so anything outside the
  // registry-editing set below is dropped rather than forwarded: an unfiltered
  // pass-through would let a crafted message steer the assistant into invoking
  // an unrelated capability (erase_data, delete_secret_key, …) under the
  // caller's own credentials.
  for (const m of object.mutations ?? []) {
    if (!APPLICABLE_MUTATION_CAPABILITIES.has(m.capability)) continue;
    const input: Record<string, unknown> = { ...m.input };
    const cap = m.capability;
    if (cap === "upsert_schema_label" || cap === "delete_schema_label") {
      if (!input.name || !input.schemaName) continue;
      if (cap === "upsert_schema_label" && !input.displayName)
        input.displayName = humanize(String(input.name));
    } else if (
      cap === "upsert_schema_relationship" ||
      cap === "delete_schema_relationship"
    ) {
      if (!input.name || !input.schemaName) continue;
      input.name = normalizeRelName(String(input.name));
      if (cap === "upsert_schema_relationship") {
        if (!input.displayName)
          input.displayName = humanize(String(input.name));
        const c = normalizeCardinality(input.cardinality);
        if (c) input.cardinality = c;
        else delete input.cardinality;
      }
    } else if (cap === "upsert_schema_property") {
      if (!input.ownerName || !input.key || !input.schemaName) continue;
      if (!input.ownerKind) input.ownerKind = "node";
      input.dataType = normalizeDataType(input.dataType);
      if (typeof input.required !== "boolean") input.required = false;
    } else if (cap === "delete_schema_property") {
      if (!input.ownerName || !input.key) continue;
    } else if (cap === "delete_schema") {
      if (!input.schemaName) continue;
    } else if (cap === "toggle_schema") {
      if (!input.schemaName || typeof input.enabled !== "boolean") continue;
    }
    out.push({ capability: cap, input });
  }

  return out;
}
