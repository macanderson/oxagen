// openapi: an OpenAPI 3.1 or 3.0 document, or Swagger 2.0, as UpstreamTool[]
// (lane M1; mcp-studio-spec, Definition import and Mapping).
//
// The steps run in this order:
//
// 1. Refuse input over DEFINITION_BYTES_MAX, naming the size and the limit.
// 2. Parse each file as YAML or JSON, and bundle a document split across
//    files into one. A $ref resolves only against the files given, so import
//    never reads a disk or fetches a URL.
// 3. Apply overlay.yaml, an Overlay 1.0 document, when the folder has one.
// 4. Convert Swagger 2.0 and OpenAPI 3.0 to 3.1 in memory. The file in the
//    folder keeps its own version.
// 5. Map each operation to one UpstreamTool with an HTTP request template.
//    Webhooks and callbacks are listed and never become tools.
// 6. Read each scheme in components.securitySchemes as a SuggestedAuth, and
//    each entry of servers as a SuggestedEnvironment.
//
// A refusal throws OpenApiImportError with a stable code. Anything import
// changes or cuts along the way becomes a note.
import { documentHash } from "../contract/hashes";
import type { ImportedFile, ImportNote, ImportResult } from "../model/import-result";
import { readAuth, readEnvironments } from "./auth";
import { ParsedFiles, bundle, bundleText } from "./bundle";
import { OpenApiImportError } from "./errors";
import type { JsonRecord } from "./json";
import { checkSize, utf8Length } from "./load";
import { readOperations } from "./operations";
import { applyOverlay } from "./overlay";
import { normalizePath } from "./ref-path";
import { Resolver } from "./resolve";
import { detectVersion, upgradeDocument } from "./upgrade";

export { OpenApiImportError, type OpenApiImportErrorCode, type OpenApiImportErrorDetail } from "./errors";

export interface OpenApiInput {
  /** Every file of the document, by path relative to the server's folder. A single-file document has one. */
  files: readonly ImportedFile[];
  /** The path of the root document among files: openapi.yaml. */
  entry: string;
  /** overlay.yaml's text, an OpenAPI Overlay 1.0, when the folder has one. */
  overlay: string | undefined;
}

/** Each file's text by its normalized path. */
function fileMap(input: OpenApiInput): { texts: Map<string, string>; entry: string } {
  const texts = new Map<string, string>();
  for (const file of input.files) {
    const path = normalizePath(file.path);
    if (path === undefined) {
      throw new OpenApiImportError(
        "ref_outside",
        `The file path "${file.path}" is absolute or climbs out of the server's folder. ` +
          "Give each file a path relative to the folder and import again.",
        { ref: file.path },
      );
    }
    texts.set(path, file.text);
  }
  const entry = normalizePath(input.entry);
  if (entry === undefined || !texts.has(entry)) {
    throw new OpenApiImportError(
      "ref_missing",
      `The entry "${input.entry}" is not among the files given. Name the root document's path and import again.`,
      { ref: input.entry },
    );
  }
  return { texts, entry };
}

function run(input: OpenApiInput): ImportResult {
  const { texts, entry } = fileMap(input);
  let total = 0;
  for (const text of texts.values()) total += utf8Length(text);
  checkSize(total, "The document");
  if (input.overlay !== undefined) checkSize(utf8Length(input.overlay), "overlay.yaml");

  const notes: ImportNote[] = [];
  const parsed = new ParsedFiles(texts);
  const version = detectVersion(parsed.get(entry), entry);
  const bundled = bundle(parsed, entry, version !== "2.0");

  // A single file is hashed as committed. A bundle is hashed as import writes it.
  const entryText = texts.get(entry) as string;
  const files: ImportedFile[] = bundled.inlined ? [{ path: entry, text: bundleText(bundled.document, entry) }] : [];
  const document_hash = documentHash(files[0]?.text ?? entryText);

  // detectVersion refused a root that is not a mapping, and an overlay cannot remove the root.
  const root = bundled.document as JsonRecord;
  if (input.overlay !== undefined) applyOverlay(root, input.overlay, notes);
  const document = upgradeDocument(root, version, notes);

  const resolver = new Resolver(document, notes);
  const { tools, listed } = readOperations(document, resolver, notes);
  resolver.beginTool(undefined);
  const auth = readAuth(document, resolver, notes);
  const environments = readEnvironments(document, notes);
  return { tools, listed, notes, environments, auth, document_hash, files, descriptor_set: undefined };
}

/**
 * The document as UpstreamTool[], one per operation, with HTTP request
 * templates. Rejects with OpenApiImportError for a document over
 * DEFINITION_BYTES_MAX, one that does not parse, or a $ref that leaves the
 * folder. files in the result holds the bundled document for a multi-file
 * input, and is empty otherwise.
 */
export async function importOpenApi(input: OpenApiInput): Promise<ImportResult> {
  return run(input);
}
