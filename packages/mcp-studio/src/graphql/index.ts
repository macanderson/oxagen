// graphql: a GraphQL schema as UpstreamTool[] (lane M2; mcp-studio-spec,
// Definition import and Mapping).
//
// Each Query and Mutation root field becomes one tool with a generated
// selection set to depth 2. Subscriptions are listed and never become tools.
// A field that follows the connection pattern gets paging.
import type { ImportResult } from "../model/import-result";
import { fromIntrospection, fromSdl } from "./load";
import { toolsOf } from "./tools";

/** An SDL file, or the result of an introspection query sent through the network route. */
export type GraphqlInput =
  | { sdl: string }
  | {
      /** The data of an introspection query result: { __schema }. */
      introspection: unknown;
    };

/**
 * The schema as UpstreamTool[], one per root field, with GraphQL request
 * templates. With introspection input, files in the result holds the schema
 * printed as SDL, so a person can review it.
 */
export async function importGraphql(input: GraphqlInput): Promise<ImportResult> {
  const loaded = "sdl" in input ? fromSdl(input.sdl) : fromIntrospection(input.introspection);
  return {
    ...toolsOf(loaded.schema),
    environments: [],
    auth: [],
    document_hash: loaded.document_hash,
    files: loaded.files,
    descriptor_set: undefined,
  };
}
