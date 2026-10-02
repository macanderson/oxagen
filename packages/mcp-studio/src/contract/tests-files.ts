// tests-files.ts: the lines of a server's tests/calls.jsonl and
// tests/selection.jsonl (mcp-studio-spec, Try it and tests).
//
// calls.jsonl holds calls saved from Studio's Try it panel. Each call keeps
// every upstream exchange in the order it was sent: one for an unpaged call,
// and one per page for a paged call. The compile check replays the exchanges
// in order with no network. Each built request must match its recorded
// request, and the shaped result must match the recorded result.
//
// A recorded call never holds a credential, because calls.jsonl is committed
// to the steering repo and a secret in git history is hard to remove. Save as
// a test records each request as built before the credential is added, so no
// header, query parameter, or cookie carries one. A recorded response keeps no
// Set-Cookie header. The header checks below are a second guard.
//
// selection.jsonl holds tasks and the tool a model should pick for each. A
// task that no tool fits expects null, and a selection run scores a model that
// picks none for it as a hit.
import { z } from "zod";
import { instantSchema, toolNameSchema } from "@oxagen/oxagen/steering-repo/common";
import { withChecks, type CustomCheck } from "./checks";
import { grpcMethodSchema, httpMethodSchema, jsonObjectSchema, jsonValueSchema, toolKeySchema } from "./primitives";

/** Request headers that carry a credential, in lowercase. A recorded request holds none of them. */
export const CREDENTIAL_REQUEST_HEADERS = ["authorization", "proxy-authorization", "cookie"] as const;

/** Response headers that carry a credential, in lowercase. A recorded response holds none of them. */
export const CREDENTIAL_RESPONSE_HEADERS = ["set-cookie"] as const;

/**
 * A pattern that matches a lowercase header name in any case. JSON Schema
 * uses ECMA-262 patterns, which have no inline flag for case, so each letter
 * becomes a class such as `[aA]`.
 */
function anyCase(name: string): string {
  return name.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
}

/** `headers` names none of `refused`, in any case. */
function noCredentialHeaders(refused: readonly string[]): CustomCheck {
  const names = new Set(refused);
  return {
    issues(value) {
      const headers = (value.headers ?? {}) as Record<string, string>;
      return Object.keys(headers)
        .filter((name) => names.has(name.toLowerCase()))
        .map((name) => ({
          path: ["headers", name],
          message: `the ${name} header is not allowed: a recorded call holds no credential`,
        }));
    },
    json: {
      properties: {
        headers: { propertyNames: { not: { pattern: `^(?:${refused.map(anyCase).join("|")})$` } } },
      },
    },
  };
}

/** The HTTP request an OpenAPI tool built, before the credential was added. */
export const recordedHttpRequestSchema = withChecks(
  z
    .object({
      method: httpMethodSchema,
      path: z.string().regex(/^\/[^\s#]*$/, "a path starts with / and has no fragment"),
      query: z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe("As built before the credential is added: no API key in the query."),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("As built before the credential is added: no Authorization, Proxy-Authorization, or Cookie."),
      body: z.unknown().optional(),
    })
    .strict(),
  [noCredentialHeaders(CREDENTIAL_REQUEST_HEADERS)],
);

/** The POST a GraphQL tool sent, before the credential was added. */
export const recordedGraphqlRequestSchema = z
  .object({
    query: z.string().min(1),
    variables: jsonObjectSchema.optional(),
  })
  .strict();

/**
 * The call a gRPC tool made, before the credential was added, with the
 * request message in its proto3 JSON form.
 */
export const recordedGrpcRequestSchema = z
  .object({
    method: grpcMethodSchema,
    message: jsonObjectSchema,
  })
  .strict();

/** The tools/call an MCP tool sent, before the credential was added. */
export const recordedMcpRequestSchema = z
  .object({
    name: z.string().min(1),
    arguments: jsonObjectSchema,
  })
  .strict();

/** An HTTP response: from an OpenAPI or GraphQL source. */
export const recordedHttpResponseSchema = withChecks(
  z
    .object({
      status: z.number().int().min(100).max(599),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Every header but Set-Cookie. A Location keeps no query or fragment.",
        ),
      body: z
        .unknown()
        .optional()
        .describe("Left out for an empty body and for a redirect."),
    })
    .strict(),
  [noCredentialHeaders(CREDENTIAL_RESPONSE_HEADERS)],
);

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

/**
 * One request that went upstream, as built before the credential was added,
 * and the response that came back.
 */
export const recordedExchangeSchema = z
  .object({
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
  })
  .strict();
export type RecordedExchange = z.output<typeof recordedExchangeSchema>;

export const recordedCallSchema = z
  .object({
    tool: toolKeySchema.describe("The tool's key in tools.toml."),
    arguments: jsonObjectSchema.describe("As the agent sent them."),
    exchanges: z
      .array(recordedExchangeSchema)
      .min(1, "a recorded call has at least one exchange")
      .describe("Every upstream exchange in the order it was sent: one per page for a paged call."),
    result: jsonValueSchema.describe("The shaped result's structuredContent, or its text when it has none."),
    recorded_at: instantSchema.optional(),
  })
  .strict();
export type RecordedCall = z.output<typeof recordedCallSchema>;

export const selectionTestSchema = z
  .object({
    task: z.string().min(1).max(2000).describe("What a person might ask the agent to do."),
    expect: toolNameSchema
      .nullable()
      .describe("The tool that fits the task, such as billing__create_refund, or null when no tool fits."),
  })
  .strict();
export type SelectionTest = z.output<typeof selectionTestSchema>;
