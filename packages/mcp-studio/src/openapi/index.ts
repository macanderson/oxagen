// openapi: an OpenAPI 3.1 or 3.0 document, or Swagger 2.0, as UpstreamTool[]
// (lane M1; mcp-studio-spec, Definition import and Mapping).
//
// Import bundles a document split across files into one, converts Swagger
// 2.0 to 3.0 in memory, resolves $ref, merges path-level and operation-level
// parameters, and applies overlay.yaml when the folder has one. Webhooks and
// callbacks are listed and never become tools. Each scheme in
// components.securitySchemes becomes a SuggestedAuth.
import type { ImportedFile, ImportResult } from "../model/import-result";
import { notBuiltAsync } from "../not-built";

export interface OpenApiInput {
  /** Every file of the document, by path relative to the server's folder. A single-file document has one. */
  files: readonly ImportedFile[];
  /** The path of the root document among files: openapi.yaml. */
  entry: string;
  /** overlay.yaml's text, an OpenAPI Overlay 1.0, when the folder has one. */
  overlay: string | undefined;
}

/**
 * The document as UpstreamTool[], one per operation, with HTTP request
 * templates. Rejects a document over DEFINITION_BYTES_MAX or one that does
 * not parse. files in the result holds the bundled document for a
 * multi-file input, and is empty otherwise.
 */
export function importOpenApi(input: OpenApiInput): Promise<ImportResult> {
  return notBuiltAsync("openapi", input);
}
