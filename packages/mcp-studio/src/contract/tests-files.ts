// tests-files.ts: the lines of a server's tests/calls.jsonl and
// tests/selection.jsonl (mcp-studio-spec, Try it and tests).
//
// calls.jsonl holds calls saved from Studio's Try it panel. The compile check
// replays each one with no network: the shaped result must match, and for a
// server built from a definition the built request must match too.
// selection.jsonl holds tasks and the tool a model should pick for each.
import { z } from "zod";
import { instantSchema, toolNameSchema } from "@oxagen/oxagen/steering-repo/common";
import { grpcMethodSchema, httpMethodSchema, jsonObjectSchema, jsonValueSchema, toolKeySchema } from "./primitives";

/** The HTTP request an OpenAPI tool built. */
export const recordedHttpRequestSchema = z
  .object({
    method: httpMethodSchema,
    path: z.string().regex(/^\/[^\s#]*$/, "a path starts with / and has no fragment"),
    query: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    headers: z.record(z.string(), z.string()).optional().describe("Every header but the credential."),
    body: z.unknown().optional(),
  })
  .strict();

/** The POST a GraphQL tool sent. */
export const recordedGraphqlRequestSchema = z
  .object({
    query: z.string().min(1),
    variables: jsonObjectSchema.optional(),
  })
  .strict();

/** The call a gRPC tool made, with the request message in its proto3 JSON form. */
export const recordedGrpcRequestSchema = z
  .object({
    method: grpcMethodSchema,
    message: jsonObjectSchema,
  })
  .strict();

/** The tools/call an MCP tool sent. */
export const recordedMcpRequestSchema = z
  .object({
    name: z.string().min(1),
    arguments: jsonObjectSchema,
  })
  .strict();

/** An HTTP response: from an OpenAPI or GraphQL source. */
export const recordedHttpResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  })
  .strict();

/** A gRPC response: the status, and the message or the stream's messages. */
export const recordedGrpcResponseSchema = z
  .object({
    code: z.string().regex(/^[A-Z_]+$/, "a gRPC status name, such as OK or UNAVAILABLE"),
    message: z.string().optional(),
    messages: z.array(jsonObjectSchema).optional(),
  })
  .strict();

/** An MCP CallToolResult, as the server sent it. */
export const recordedMcpResponseSchema = z
  .object({
    content: z.array(jsonObjectSchema),
    structuredContent: jsonObjectSchema.optional(),
    isError: z.boolean().optional(),
  })
  .strict();

export const recordedCallSchema = z
  .object({
    tool: toolKeySchema.describe("The tool's key in tools.toml."),
    arguments: jsonObjectSchema.describe("As the agent sent them."),
    request: z
      .union([
        recordedHttpRequestSchema,
        recordedGraphqlRequestSchema,
        recordedGrpcRequestSchema,
        recordedMcpRequestSchema,
      ])
      .describe("What went upstream."),
    response: z
      .union([recordedHttpResponseSchema, recordedGrpcResponseSchema, recordedMcpResponseSchema])
      .describe("What came back."),
    result: jsonValueSchema.describe("The shaped result's structuredContent, or its text when it has none."),
    recorded_at: instantSchema.optional(),
  })
  .strict();
export type RecordedCall = z.output<typeof recordedCallSchema>;

export const selectionTestSchema = z
  .object({
    task: z.string().min(1).max(2000).describe("What a person might ask the agent to do."),
    expect: toolNameSchema.describe("The tool that fits the task: billing__create_refund."),
  })
  .strict();
export type SelectionTest = z.output<typeof selectionTestSchema>;
