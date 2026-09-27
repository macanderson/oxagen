// tools.ts: `mcp-tools/v1`, the schema of tools/servers/<name>/tools.toml
// (mcp-studio-spec, Tools file and Risk classification).
//
// tools.toml lists the imported tools. A tool the server offers and this file
// does not list is visible to no agent. Each table's key is the tool's name
// after the server prefix.
//
// The classification keys are the fields of today's ToolClassification in
// snake case, and the enums are the same zod schemas, imported from
// packages/oxagen/src/contracts/tool.classification.ts. `impacts` is today's
// `consequenceTags` until lane M13 renames it (classification.ts maps it).
import { z } from "zod";
import {
  consequenceTagSchema,
  toolClassificationSchema,
  toolEgressClassSchema,
  toolMeasureSchema,
  toolRiskGradeSchema,
  toolSideEffectClassSchema,
} from "@oxagen/oxagen/contracts/tool.classification";
import { atMostOne, dependentRequired, uniqueList, withChecks, type CustomCheck } from "./checks";
import {
  finiteJsonValueSchema,
  graphqlFieldSchema,
  grpcMethodSchema,
  headerNameSchema,
  inputNameSchema,
  resultPathSchema,
  toolKeySchema,
  upstreamToolNameSchema,
} from "./primitives";

/** The most a result may carry after shaping: 1 MB. */
export const MAX_RESULT_BYTES_LIMIT = 1_048_576;
/** The size cap when neither the tool nor [defaults] names one. */
export const DEFAULT_MAX_RESULT_BYTES = 65_536;
/** Every send has a 30-second deadline by default (mcp-studio-spec, Call path). */
export const DEFAULT_DEADLINE_MS = 30_000;
export const MAX_DEADLINE_MS = 300_000;
/** The most items auto paging or a gRPC server stream collects. */
export const MAX_ITEMS_LIMIT = 10_000;
/** A description is at most 1,024 characters: a replacement in tools.toml, or the source's own, cut on import. */
export const TOOL_DESCRIPTION_MAX = 1024;

const measureShape = toolMeasureSchema.innerType().shape;
const classificationShape = toolClassificationSchema.innerType().shape;

/** One measure in snake case: today's ToolMeasure with currencyPath written currency_path. */
export const toolsMeasureSchema = withChecks(
  z
    .object({
      path: measureShape.path,
      type: measureShape.type,
      currency_path: measureShape.currencyPath,
      unit: measureShape.unit,
    })
    .strict(),
  [{ kind: "require", when: { field: "type", is: "money" }, fields: ["currency_path"] }],
);
export type ToolsMeasure = z.output<typeof toolsMeasureSchema>;

/** The name an agent sees for a renamed input. */
const agentInputNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, "a renamed input is letters, digits, and underscores");

const PAGINATE_BY_OPERATION = ["cursor", "page", "offset"] as const;

/** max_items caps auto paging or a gRPC server stream, so it needs one of them. */
const maxItemsNeedsPaging: CustomCheck = {
  issues: (value) =>
    value.max_items !== undefined && value.paginate === undefined && value.method === undefined
      ? [{ path: ["max_items"], message: "max_items needs paginate, or method for a gRPC server stream" }]
      : [],
  json: {
    if: { required: ["max_items"] },
    then: { anyOf: [{ required: ["paginate"] }, { required: ["method"] }] },
  },
};

export const toolsEntrySchema = withChecks(
  z
    .object({
      // Which upstream operation the tool is.
      upstream: upstreamToolNameSchema
        .optional()
        .describe("MCP: the server's own tool name. Defaults to the table key."),
      operation: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe('OpenAPI: the operationId, or "POST /refunds/{id}/cancel" when the operation has none.'),
      field: graphqlFieldSchema.optional().describe("GraphQL: the root field, such as Mutation.createRefund."),
      selection: z
        .string()
        .min(1)
        .max(16_384)
        .optional()
        .describe("GraphQL: the selection set sent with every call."),
      method: grpcMethodSchema
        .optional()
        .describe("gRPC: the full method name, such as a_intel.ledger.v1.Ledger/PostEntry."),
      deadline_ms: z
        .number()
        .int()
        .min(1)
        .max(MAX_DEADLINE_MS)
        .optional()
        .describe(`gRPC: the call's deadline. ${DEFAULT_DEADLINE_MS} when omitted.`),

      // Classification: today's ToolClassification in snake case.
      risk: toolRiskGradeSchema,
      side_effect: toolSideEffectClassSchema,
      egress: toolEgressClassSchema,
      impacts: uniqueList(consequenceTagSchema, "impacts", 32)
        .optional()
        .describe("What a call can do. Today's consequenceTags."),
      measures: z
        .record(classificationShape.measures.keySchema, toolsMeasureSchema)
        .optional()
        .describe("Named paths into the input, each with a type."),
      data_classes: classificationShape.dataClasses.optional().describe("Up to 64 names of data the tool touches."),

      // Shaping.
      description: z
        .string()
        .min(1)
        .max(TOOL_DESCRIPTION_MAX)
        .optional()
        .describe("Replaces the source's description."),
      hide: uniqueList(inputNameSchema, "hide", 256).optional().describe("Inputs that leave the schema."),
      fixed: z
        .record(inputNameSchema, finiteJsonValueSchema)
        .optional()
        .describe("Inputs set on every call. A fixed input leaves the schema."),
      defaults: z
        .record(inputNameSchema, finiteJsonValueSchema)
        .optional()
        .describe("Values for inputs the model leaves out."),
      rename: z
        .record(inputNameSchema, agentInputNameSchema)
        .optional()
        .describe("Upstream input name to the name the agent sees. The gateway maps it back on the call."),
      select: uniqueList(resultPathSchema, "select", 256).optional().describe("The result paths kept."),
      redact: uniqueList(resultPathSchema, "redact", 256).optional().describe("The result paths removed."),
      max_result_bytes: z
        .number()
        .int()
        .min(1)
        .max(MAX_RESULT_BYTES_LIMIT)
        .optional()
        .describe("The result's size cap after select and redact."),
      paginate: z
        .enum(["cursor", "page", "offset", "connection"])
        .optional()
        .describe("cursor, page, or offset for OpenAPI, and connection for GraphQL."),
      max_items: z
        .number()
        .int()
        .min(1)
        .max(MAX_ITEMS_LIMIT)
        .optional()
        .describe("Caps auto paging and a gRPC server stream."),
      idempotency_header: headerNameSchema
        .optional()
        .describe("OpenAPI: the header that carries an idempotency key on a POST."),
    })
    .strict(),
  [
    atMostOne(["upstream", "operation", "field", "method"]),
    dependentRequired("selection", ["field"]),
    dependentRequired("idempotency_header", ["operation"]),
    dependentRequired("deadline_ms", ["method"]),
    { kind: "require", when: { field: "paginate", is: "connection" }, fields: ["field"] },
    ...PAGINATE_BY_OPERATION.map((style) => ({
      kind: "require" as const,
      when: { field: "paginate", is: style },
      fields: ["operation"],
    })),
    maxItemsNeedsPaging,
  ],
);
export type ToolsEntry = z.output<typeof toolsEntrySchema>;

export const mcpToolsSchema = z
  .object({
    schema: z.literal("mcp-tools/v1"),
    defaults: z
      .object({
        max_result_bytes: z.number().int().min(1).max(MAX_RESULT_BYTES_LIMIT).optional(),
      })
      .strict()
      .optional()
      .describe("Values every tool takes unless its own table sets them."),
    tools: z
      .record(toolKeySchema, toolsEntrySchema)
      .optional()
      .describe("The imported tools, keyed by the name after the server prefix."),
  })
  .strict();
export type McpTools = z.output<typeof mcpToolsSchema>;
