// primitives.ts: the small shapes several MCP Studio schemas share.
import { z } from "zod";
import { withJsonSchema } from "@oxagen/oxagen/steering-repo/json-schema";
import {
  BUILTIN_SERVER,
  SERVER_NAME_PATTERN,
  TOOL_KEY_PATTERN,
  TOOL_NAME_MAX,
  TOOL_SEPARATOR,
} from "@oxagen/oxagen/steering-repo/names";

/** The folder name under tools/servers/ and the prefix of every tool name. `builtin` is reserved. */
export const serverNameSchema = withJsonSchema(
  z
    .string()
    .regex(
      SERVER_NAME_PATTERN,
      "a server name starts with a letter and has at most 24 lowercase letters, digits, and underscores",
    )
    .refine((name) => name !== BUILTIN_SERVER, {
      message: `${BUILTIN_SERVER} is reserved for Oxagen's built-in tools`,
    }),
  { not: { const: BUILTIN_SERVER } },
);

/** The longest tool key: the shortest server name and the separator leave this much of 64. */
export const TOOL_KEY_MAX = TOOL_NAME_MAX - 1 - TOOL_SEPARATOR.length;

/** A tool's key in tools.toml: the name after the server prefix. */
export const toolKeySchema = z
  .string()
  .max(TOOL_KEY_MAX)
  .regex(
    TOOL_KEY_PATTERN,
    "a tool key starts with a letter and uses lowercase letters, digits, and underscores",
  );

/** An http or https URL. */
export const httpUrlSchema = z
  .string()
  .url()
  .regex(/^https?:\/\//, "a URL starts with https:// or http://");

/** A relay's name, as `relay:<name>` writes it. */
export const RELAY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** `cloud`, or `relay:<name>` for a server inside a private network. */
export const networkSchema = z
  .string()
  .regex(
    /^(?:cloud|relay:[a-z0-9][a-z0-9-]{0,62})$/,
    "a network is cloud or relay:<name>",
  );

/** An environment's key under [environments]. */
export const environmentNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,31}$/,
    "an environment name starts with a letter and has at most 32 lowercase letters, digits, and underscores",
  );

/** An HTTP header name (RFC 9110 token). */
export const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/, "not an HTTP header name");

/** A lowercase host name or IPv4 address, with no port. */
export const hostSchema = z
  .string()
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    "a host is a lowercase name or an IPv4 address, with no port",
  );

/** A TCP port. */
export const portSchema = z.number().int().min(1).max(65535);

/** The HTTP methods an OpenAPI operation can use. */
export const httpMethodSchema = z.enum([
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
  "TRACE",
]);
export type HttpMethod = z.output<typeof httpMethodSchema>;

/** A gRPC method's full name: `a_intel.ledger.v1.Ledger/PostEntry`. */
export const grpcMethodSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\/[A-Za-z_][A-Za-z0-9_]*$/,
    "a gRPC method is <package>.<Service>/<Method>",
  );

/** A protobuf message or service's full name: `a_intel.ledger.v1.Entry`. */
export const protoFullNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/,
    "a protobuf name is dotted identifiers",
  );

/** A GraphQL root field: `Mutation.createRefund`. */
export const graphqlFieldSchema = z
  .string()
  .regex(
    /^[_A-Za-z][_0-9A-Za-z]*\.[_A-Za-z][_0-9A-Za-z]*$/,
    "a GraphQL field is <RootType>.<field>, such as Mutation.createRefund",
  );

/**
 * A path into a tool's result: `data[].id`, `has_more`, `pageInfo.endCursor`.
 * `[]` steps into every item of an array.
 */
export const resultPathSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)*$/,
    "a result path is dotted field names, with [] after an array, such as data[].id",
  );

/** An input property's name as the upstream definition spells it. Headers keep their hyphens. */
export const inputNameSchema = z.string().min(1).max(128);

/** An upstream MCP tool's name, as the server spells it. */
export const upstreamToolNameSchema = z.string().min(1).max(128);

/** Base64 with padding. */
export const base64Schema = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "not base64");

/**
 * Any JSON value, required. A bare `z.unknown()` counts as optional, so an
 * object would accept a missing key and JSON Schema would leave it out of
 * `required`. This one refuses a missing key in both.
 */
export const jsonValueSchema = z
  .unknown()
  .refine((value) => value !== undefined, { message: "Required" });
export type JsonValue = unknown;

/** A JSON object with any keys. */
export const jsonObjectSchema = z.record(z.string(), z.unknown());

/** A JSON Schema whose type is object, as MCP requires of inputSchema and outputSchema. */
export const objectJsonSchemaSchema = z
  .object({ type: z.literal("object") })
  .passthrough()
  .describe("A JSON Schema whose type is object.");
export type ObjectJsonSchema = z.output<typeof objectJsonSchemaSchema>;
