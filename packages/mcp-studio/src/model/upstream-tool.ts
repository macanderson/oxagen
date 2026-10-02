// upstream-tool.ts: the format-neutral operation model (mcp-studio-spec,
// Sources: Build cost by format).
//
// Every importer turns its source into UpstreamTool values: an MCP server's
// tools/list, an OpenAPI operation, a GraphQL root field, or a gRPC method.
// Everything after import (compile, the lock, diff, suggest, lint, and the
// executor) reads only this model, so each of those treats every format the
// same. Only the request template says how a call reaches the source.
//
// A lock file for a server built from a definition pins this value as the
// tool's upstream, so every field here is plain JSON with a published schema.
import { z } from "zod";
import {
  impactSchema,
  toolEgressClassSchema,
  toolRiskGradeSchema,
  toolSideEffectClassSchema,
} from "@oxagen/oxagen/contracts/tool.classification";
import { uniqueList } from "../contract/checks";
import { lockedMcpToolAnnotationsSchema } from "../contract/mcp-tool";
import {
  graphqlFieldSchema,
  grpcMethodSchema,
  httpMethodSchema,
  httpUrlSchema,
  inputNameSchema,
  objectJsonSchemaSchema,
  protoFullNameSchema,
  resultPathSchema,
  toolKeySchema,
  upstreamToolNameSchema,
} from "../contract/primitives";
import { TOOL_DESCRIPTION_MAX } from "../contract/tools";

// ── Request templates ────────────────────────────────────────────────────────

/** An MCP source: tools/call with the server's own tool name. */
export const mcpRequestSchema = z
  .object({
    kind: z.literal("mcp"),
    tool: upstreamToolNameSchema.describe("The name tools/call sends: the server's own name."),
  })
  .strict();
export type McpRequest = z.output<typeof mcpRequestSchema>;

/** One OpenAPI parameter, and the input property that carries it. */
export const httpParameterSchema = z
  .object({
    name: inputNameSchema.describe("The parameter's name as the API spells it."),
    in: z.enum(["path", "query", "header", "cookie"]),
    property: inputNameSchema.describe("The inputSchema property that carries the value."),
    required: z.boolean(),
    style: z
      .enum(["simple", "label", "matrix", "form", "spaceDelimited", "pipeDelimited", "deepObject", "cookie"])
      .optional()
      .describe("OpenAPI's serialization style, when it differs from the default for `in`."),
    explode: z
      .boolean()
      .optional()
      .describe("OpenAPI's explode. Import writes it on every cookie parameter, so the executor never guesses its default."),
    allow_reserved: z
      .boolean()
      .optional()
      .describe(
        "A query parameter only: true sends reserved characters such as / and : in the value without percent-encoding (OpenAPI's allowReserved).",
      ),
  })
  .strict();
export type HttpParameter = z.output<typeof httpParameterSchema>;

const mediaTypeSchema = z
  .string()
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/, "a media type is <type>/<subtype> in lowercase");

/** A body whose properties sit at the top level of inputSchema, because no name collides with a parameter. */
export const httpSpreadBodySchema = z
  .object({
    in: z.literal("spread"),
    media_type: mediaTypeSchema,
    required: z.boolean(),
    properties: uniqueList(inputNameSchema, "properties").describe(
      "The inputSchema properties that make up the body.",
    ),
  })
  .strict();

/** A body carried whole by one input property, because a body property collides with a parameter. */
export const httpPropertyBodySchema = z
  .object({
    in: z.literal("property"),
    media_type: mediaTypeSchema,
    required: z.boolean(),
    property: inputNameSchema.describe("The inputSchema property that carries the body: body."),
  })
  .strict();

export const httpBodySchema = z.union([httpSpreadBodySchema, httpPropertyBodySchema]);
export type HttpBody = z.output<typeof httpBodySchema>;

/** The 2xx JSON response the result comes from. */
export const httpResponseSchema = z
  .object({
    status: z
      .string()
      .regex(/^2(?:[0-9]{2}|XX)$/, "a success status is 2xx or 2XX")
      .describe("The response the outputSchema describes: 200, 201, or 2XX."),
    media_type: mediaTypeSchema,
    wrap: z
      .literal("items")
      .optional()
      .describe("An array response arrives as { items }, because MCP requires an object result."),
  })
  .strict();
export type HttpResponse = z.output<typeof httpResponseSchema>;

/** An OpenAPI source: the HTTP request built from one operation. */
export const httpRequestSchema = z
  .object({
    kind: z.literal("http"),
    operation: z
      .string()
      .min(1)
      .max(256)
      .describe('The operationId, or "POST /refunds/{id}/cancel" when the operation has none.'),
    method: httpMethodSchema,
    path: z
      .string()
      .regex(/^\/[^\s?#]*$/, "a path template starts with / and has no query or fragment")
      .describe("The path template, relative to the environment's url, or to base_url when the operation has one."),
    base_url: httpUrlSchema
      .optional()
      .describe(
        "The operation's own server, from the servers list on the operation or its path item, when that list differs from the document's. A call sends to it in every environment.",
      ),
    parameters: z
      .array(httpParameterSchema)
      .describe("Every parameter the operation declares. Compile drops one that the server's API key scheme supplies."),
    body: httpBodySchema.optional(),
    response: httpResponseSchema.optional().describe("Absent when no 2xx response has a JSON schema."),
    security: z
      .array(z.record(z.string().min(1), z.array(z.string())))
      .optional()
      .describe("The operation's security requirements, as OpenAPI writes them. The gateway adds these."),
  })
  .strict();
export type HttpRequest = z.output<typeof httpRequestSchema>;

/** One GraphQL argument, and the input property that carries it. */
export const graphqlArgumentSchema = z
  .object({
    name: z.string().regex(/^[_A-Za-z][_0-9A-Za-z]*$/, "not a GraphQL name"),
    type: z
      .string()
      .regex(/^[[\]!_A-Za-z0-9]+$/, "a GraphQL type reference, such as ID! or [String!]")
      .describe("The argument's type as the operation declares its variable."),
    property: inputNameSchema.describe("The inputSchema property that carries the value."),
  })
  .strict();
export type GraphqlArgument = z.output<typeof graphqlArgumentSchema>;

/** A GraphQL source: one POST with the selection set and the arguments as variables. */
export const graphqlRequestSchema = z
  .object({
    kind: z.literal("graphql"),
    operation_type: z.enum(["query", "mutation"]),
    field: graphqlFieldSchema,
    arguments: z.array(graphqlArgumentSchema),
    selection: z
      .string()
      .min(1)
      .max(16_384)
      .optional()
      .describe("The generated selection set, to depth 2. tools.toml's selection replaces it. Absent for a scalar field."),
  })
  .strict();
export type GraphqlRequest = z.output<typeof graphqlRequestSchema>;

/** A method's idempotency_level option, as protobuf names it. */
export const grpcIdempotencyLevelSchema = z.enum([
  "IDEMPOTENCY_UNKNOWN",
  "NO_SIDE_EFFECTS",
  "IDEMPOTENT",
]);
export type GrpcIdempotencyLevel = z.output<typeof grpcIdempotencyLevelSchema>;

/** A gRPC source: one unary or server-streaming call, encoded from the descriptors. */
export const grpcRequestSchema = z
  .object({
    kind: z.literal("grpc"),
    method: grpcMethodSchema,
    streaming: z
      .enum(["unary", "server"])
      .describe("A server-streaming result is { items, truncated }. Client and bidirectional streams never become tools."),
    idempotency_level: grpcIdempotencyLevelSchema,
    request_type: protoFullNameSchema,
    response_type: protoFullNameSchema,
  })
  .strict();
export type GrpcRequest = z.output<typeof grpcRequestSchema>;

/** How a call reaches the source. The executor has one Sender per kind. */
export const requestTemplateSchema = z.union([
  mcpRequestSchema,
  httpRequestSchema,
  graphqlRequestSchema,
  grpcRequestSchema,
]);
export type RequestTemplate = z.output<typeof requestTemplateSchema>;
export type RequestKind = RequestTemplate["kind"];
export const REQUEST_KINDS = ["mcp", "http", "graphql", "grpc"] as const satisfies readonly RequestKind[];

// ── Hints ────────────────────────────────────────────────────────────────────

/** What an API team suggests at the source: OpenAPI's x-oxagen-tool on an operation. */
export const toolSuggestionSchema = z
  .object({
    name: toolKeySchema.optional(),
    description: z.string().min(1).max(1024).optional(),
    risk: toolRiskGradeSchema.optional(),
    side_effect: toolSideEffectClassSchema.optional(),
    egress: toolEgressClassSchema.optional(),
    impacts: uniqueList(impactSchema, "impacts", 32).optional(),
  })
  .strict();
export type ToolSuggestion = z.output<typeof toolSuggestionSchema>;

/** Where a paged operation takes its position and returns the next one. */
export const pagingSchema = z
  .object({
    style: z.enum(["cursor", "page", "offset", "connection"]),
    input: inputNameSchema.describe("The input that carries the cursor, page, or offset: cursor, page, after."),
    next: resultPathSchema
      .optional()
      .describe("Where the result holds the next cursor: next_cursor, pageInfo.endCursor."),
    has_more: resultPathSchema.optional().describe("Where the result says more pages remain: has_more, pageInfo.hasNextPage."),
    items: resultPathSchema.describe("The array the pages add to: data, edges."),
    limit: inputNameSchema.optional().describe("The input that sets the page size."),
  })
  .strict();
export type Paging = z.output<typeof pagingSchema>;

// ── The model ────────────────────────────────────────────────────────────────

export const upstreamToolSchema = z
  .object({
    name: upstreamToolNameSchema.describe(
      "An MCP tool's own name, or the suggested tool key for an operation, field, or method: create_refund.",
    ),
    title: z.string().min(1).optional(),
    description: z
      .string()
      .max(TOOL_DESCRIPTION_MAX)
      .optional()
      .describe("From the source, cut at 1,024 characters. Absent when the source has none."),
    inputSchema: objectJsonSchemaSchema.describe("Every input in one object, before tools.toml applies."),
    outputSchema: objectJsonSchemaSchema.optional(),
    annotations: lockedMcpToolAnnotationsSchema
      .optional()
      .describe("An MCP server's hints, or the ones a format implies, such as idempotentHint for PUT and DELETE."),
    deprecated: z.boolean().optional(),
    suggestion: toolSuggestionSchema.optional(),
    paging: pagingSchema.optional().describe("How to page the operation, when import found a paging pattern."),
    request: requestTemplateSchema,
  })
  .strict();
export type UpstreamTool = z.output<typeof upstreamToolSchema>;

/** A tool with request template kind K. */
export type UpstreamToolOf<K extends RequestKind> = UpstreamTool & {
  request: Extract<RequestTemplate, { kind: K }>;
};

/**
 * A source's description cut to 1,024 UTF-16 code units, the length zod
 * counts. A cut that would split a surrogate pair drops the pair's first half
 * too, so the text stays valid. Every importer cuts with this.
 */
export function cutDescription(text: string): string {
  if (text.length <= TOOL_DESCRIPTION_MAX) return text;
  const last = text.charCodeAt(TOOL_DESCRIPTION_MAX - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? TOOL_DESCRIPTION_MAX - 1 : TOOL_DESCRIPTION_MAX);
}
