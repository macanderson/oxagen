// manifest.ts: `tool-manifest/v1`, the compiled tools of one published
// steering version (mcp-studio-spec, Storage model and Large servers).
//
// Publishing compiles every server folder into one entry here, and the bundle
// (`bundle/v1`, from S0) carries the manifest in its `tools` slot. The cloud
// gateway serves tools/list from it and runs each call from it, so it holds
// everything a call needs except the credential: the effective definition,
// the classification, the shaping, and the request template. Every default
// is resolved, so no reader applies one.
import { z } from "zod";
import {
  impactSchema,
  toolClassificationSchema,
  toolEgressClassSchema,
  toolRiskGradeSchema,
  toolSideEffectClassSchema,
} from "@oxagen/oxagen/contracts/tool.classification";
import { credentialRefSchema, sha256Schema, toolNameSchema } from "@oxagen/oxagen/steering-repo/common";
import { securitySchemeSchema } from "../model/security-scheme";
import { pagingSchema, requestTemplateSchema } from "../model/upstream-tool";
import { uniqueList } from "./checks";
import { definitionLockSourceSchema, mcpLockSourceSchema } from "./lock";
import {
  base64Schema,
  environmentNameSchema,
  finiteJsonValueSchema,
  headerNameSchema,
  httpUrlSchema,
  inputNameSchema,
  objectJsonSchemaSchema,
  resultPathSchema,
  serverNameSchema,
  toolKeySchema,
} from "./primitives";
import { serverSourceSchema } from "./server";
import { MAX_DEADLINE_MS, MAX_ITEMS_LIMIT, MAX_RESULT_BYTES_LIMIT, toolsMeasureSchema } from "./tools";

/** The three tools a server in search mode exposes, after its prefix. */
export const SEARCH_MODE_TOOLS = ["search", "describe", "call"] as const;

const tokensSchema = z.number().int().min(0);

/** The annotations the gateway sends, derived from the classification. Always all three. */
export const effectiveAnnotationsSchema = z
  .object({
    readOnlyHint: z.boolean().describe("side_effect is read."),
    destructiveHint: z.boolean().describe("side_effect is irreversible."),
    openWorldHint: z.boolean().describe("egress is third_party."),
  })
  .strict();
export type EffectiveAnnotations = z.output<typeof effectiveAnnotationsSchema>;

/** One tools/list entry as the agent receives it. */
export const effectiveDefinitionSchema = z
  .object({
    name: toolNameSchema.describe("The full name: billing__create_refund."),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    inputSchema: objectJsonSchemaSchema,
    outputSchema: objectJsonSchemaSchema.optional(),
    annotations: effectiveAnnotationsSchema,
  })
  .strict();
export type EffectiveDefinition = z.output<typeof effectiveDefinitionSchema>;

/** The classification with every optional key resolved. */
export const manifestClassificationSchema = z
  .object({
    risk: toolRiskGradeSchema,
    side_effect: toolSideEffectClassSchema,
    egress: toolEgressClassSchema,
    impacts: uniqueList(impactSchema, "impacts", 32),
    measures: z.record(toolClassificationSchema.innerType().shape.measures.keySchema, toolsMeasureSchema),
    data_classes: toolClassificationSchema.innerType().shape.dataClasses,
  })
  .strict();
export type ManifestClassification = z.output<typeof manifestClassificationSchema>;

/** The shaping keys of tools.toml with their defaults resolved. */
export const manifestShapingSchema = z
  .object({
    hide: z.array(inputNameSchema),
    fixed: z.record(inputNameSchema, finiteJsonValueSchema),
    defaults: z.record(inputNameSchema, finiteJsonValueSchema),
    rename: z.record(inputNameSchema, z.string().min(1)).describe("Upstream name to the name the agent sees."),
    select: z.array(resultPathSchema),
    redact: z.array(resultPathSchema),
    max_result_bytes: z.number().int().min(1).max(MAX_RESULT_BYTES_LIMIT),
    deadline_ms: z
      .number()
      .int()
      .min(1)
      .max(MAX_DEADLINE_MS)
      .describe("Every send has one. 30,000 unless tools.toml sets deadline_ms."),
    paginate: z.enum(["cursor", "page", "offset", "connection"]).optional(),
    max_items: z.number().int().min(1).max(MAX_ITEMS_LIMIT).optional(),
    idempotency_header: headerNameSchema.optional(),
  })
  .strict();
export type ManifestShaping = z.output<typeof manifestShapingSchema>;

export const manifestToolSchema = z
  .object({
    name: toolNameSchema,
    version: z.number().int().min(1),
    definition_hash: sha256Schema,
    upstream_hash: sha256Schema,
    definition: effectiveDefinitionSchema,
    tokens: tokensSchema.describe("The definition's tokens, counted with countTokens over its RFC 8785 form."),
    classification: manifestClassificationSchema,
    shaping: manifestShapingSchema,
    request: requestTemplateSchema.describe("The upstream template, with tools.toml's GraphQL selection applied."),
    paging: pagingSchema.optional(),
    deprecated: z.boolean().optional(),
  })
  .strict();
export type ManifestTool = z.output<typeof manifestToolSchema>;

/**
 * The route a call takes: server.toml's network, or `local` for a server the
 * local gateway runs on an enrolled machine (a local source, or a registry
 * source with machines), which has no [environments] table.
 */
export const manifestNetworkSchema = z
  .string()
  .regex(
    /^(?:cloud|local|relay:[a-z0-9][a-z0-9-]{0,62})$/,
    "a network is cloud, local, or relay:<name>",
  );

/** One environment with every default resolved. A server the local gateway runs has one, `default`, on the local network. */
export const manifestEnvironmentSchema = z
  .object({
    sandbox: z
      .boolean()
      .describe("True for the one environment every agent's calls go to: the one marked sandbox, or the only one."),
    url: httpUrlSchema.optional().describe("Absent for a server the local gateway runs."),
    network: manifestNetworkSchema,
    credential: credentialRefSchema.optional(),
  })
  .strict();
export type ManifestEnvironment = z.output<typeof manifestEnvironmentSchema>;

/** server.toml's auth, with the scheme it names resolved to how the credential is applied. */
export const manifestAuthSchema = z
  .object({
    mode: z.enum(["service", "operator-oauth"]),
    scheme: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, "not a scheme name").describe("As server.toml names it."),
    apply: securitySchemeSchema.describe("What the scheme means: from the lock for OpenAPI, or from the scheme's name."),
  })
  .strict();
export type ManifestAuth = z.output<typeof manifestAuthSchema>;

export const manifestServerSchema = z
  .object({
    name: serverNameSchema,
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(200),
    source: serverSourceSchema.describe("As server.toml writes it."),
    pinned: z
      .union([mcpLockSourceSchema, definitionLockSourceSchema])
      .describe("As tools.lock.json pins it."),
    auth: manifestAuthSchema
      .nullable()
      .describe("Null when the mode is none or the local gateway runs the server. Each environment names its credential."),
    environments: z.record(environmentNameSchema, manifestEnvironmentSchema),
    exposure: z
      .object({ mode: z.enum(["direct", "search"]), definition_budget: z.number().int().min(1) })
      .strict(),
    tokens: z
      .object({
        definitions: tokensSchema.describe("Every imported tool's definition together."),
        request: tokensSchema.describe("What each model request pays: the definitions, or the three search tools."),
      })
      .strict(),
    search: z
      .array(effectiveDefinitionSchema)
      .min(SEARCH_MODE_TOOLS.length)
      .max(SEARCH_MODE_TOOLS.length)
      .nullable()
      .describe("The search, describe, and call definitions in search mode. Null in direct mode."),
    tools: z.record(toolKeySchema, manifestToolSchema),
    descriptor_set: base64Schema
      .optional()
      .describe("gRPC only: the FileDescriptorSet the executor encodes and decodes with."),
  })
  .strict();
export type ManifestServer = z.output<typeof manifestServerSchema>;

export const toolManifestSchema = z
  .object({
    schema: z.literal("tool-manifest/v1"),
    servers: z.array(manifestServerSchema).describe("One entry per server folder, ordered by name."),
  })
  .strict();
export type ToolManifest = z.output<typeof toolManifestSchema>;
