// load.ts: a GraphQL schema from SDL or from an introspection result
// (mcp-studio-spec, Definition import). Import refuses a definition over
// 25 MB, and a schema that does not validate.
import {
  buildASTSchema,
  buildClientSchema,
  GraphQLError,
  parse,
  printSchema,
  validateSchema,
  type GraphQLSchema,
  type IntrospectionQuery,
} from "graphql";
import type { Sha256Digest } from "@oxagen/run-evidence";
import { isRecord } from "../compile/json-schema";
import { documentHash } from "../contract/hashes";
import { DEFINITION_BYTES_MAX } from "../model/definition-limits";
import type { ImportedFile } from "../model/import-result";

export interface LoadedSchema {
  schema: GraphQLSchema;
  files: ImportedFile[];
  document_hash: Sha256Digest;
}

/** The schema an SDL file describes. document_hash covers the file's bytes. */
export function fromSdl(sdl: string): LoadedSchema {
  const bytes = new TextEncoder().encode(sdl);
  refuseOversize(bytes.byteLength);
  let schema: GraphQLSchema;
  try {
    schema = buildASTSchema(parse(sdl));
  } catch (error) {
    throw new Error(`The SDL does not describe a schema. ${reason(error)}`, { cause: error });
  }
  return { schema: validated(schema), files: [], document_hash: documentHash(bytes) };
}

/**
 * The schema an introspection result describes. It takes the result's data,
 * { __schema }, or the whole response, { data: { __schema } }. The schema
 * printed as SDL is the file a person reviews, so document_hash covers it.
 */
export function fromIntrospection(result: unknown): LoadedSchema {
  const data = isRecord(result) && isRecord(result.data) ? result.data : result;
  if (!isRecord(data) || !isRecord(data.__schema)) {
    throw new Error(
      "The introspection result has no __schema object. Pass the data of an introspection query: { \"__schema\": { ... } }.",
    );
  }
  let schema: GraphQLSchema;
  try {
    schema = buildClientSchema(data as unknown as IntrospectionQuery);
  } catch (error) {
    throw new Error(`The introspection result does not describe a schema. ${reason(error)}`, { cause: error });
  }
  const text = printSchema(validated(schema));
  const bytes = new TextEncoder().encode(text);
  refuseOversize(bytes.byteLength);
  return { schema, files: [{ path: "schema.graphql", text }], document_hash: documentHash(bytes) };
}

function refuseOversize(bytes: number): void {
  if (bytes <= DEFINITION_BYTES_MAX) return;
  throw new Error(
    `The schema is ${bytes.toLocaleString("en-US")} bytes. Import refuses a definition over 25 MB, so split the schema or import a smaller one.`,
  );
}

function validated(schema: GraphQLSchema): GraphQLSchema {
  const errors = validateSchema(schema);
  if (errors.length === 0) return schema;
  throw new Error(`The schema is not valid. ${errors.map(located).join(" ")}`);
}

function reason(error: unknown): string {
  if (error instanceof GraphQLError) return located(error);
  return error instanceof Error ? error.message : String(error);
}

/** The message, after its line and column when the error has them. */
function located(error: GraphQLError): string {
  const at = error.locations?.[0];
  return at === undefined ? error.message : `Line ${at.line}, column ${at.column}: ${error.message}`;
}
