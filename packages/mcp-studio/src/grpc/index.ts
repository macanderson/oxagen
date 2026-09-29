// grpc: a protobuf package as UpstreamTool[] (lane M3; mcp-studio-spec,
// Definition import and Mapping).
//
// The steps run in this order:
//
// 1. Read the .proto files under proto/ with the files they import, or the
//    FileDescriptorProtos server reflection returned. Reflection's files are
//    printed as .proto text (print.ts) and read back like any other folder.
// 2. Parse each file in pure JS with protobufjs, with no protoc and no native
//    build, and resolve every import and type name into one
//    FileDescriptorSet (set.ts). A well-known type the folder lacks comes
//    from @bufbuild/protobuf.
// 3. Map each unary and server-streaming method to one UpstreamTool with a
//    gRPC request template (tools.ts). Client and bidirectional streams are
//    listed and never become tools.
//
// A refusal throws GrpcImportError with a stable code. Anything import
// changes or cuts along the way becomes a note.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { documentHash } from "../contract/hashes";
import { formatJson } from "../contract/json";
import { Notes } from "../graphql/notes";
import type { ImportedFile, ImportResult } from "../model/import-result";
import { fromReflection } from "./reflection";
import { buildSet } from "./set";
import { toolsOf } from "./tools";

export { GrpcImportError, type GrpcImportErrorCode } from "./errors";

export type GrpcInput =
  | {
      /** The .proto files with their imports, by path relative to the server's folder. */
      files: readonly ImportedFile[];
    }
  | {
      /** What server reflection returned: serialized FileDescriptorProto messages. */
      reflection: { file_descriptor_protos: readonly Uint8Array[] };
    };

/**
 * The package as UpstreamTool[], one per method, with gRPC request templates.
 * descriptor_set in the result is the serialized FileDescriptorSet the
 * executor encodes with. With reflection input, files holds the .proto text
 * Oxagen writes under proto/.
 */
export async function importGrpc(input: GrpcInput): Promise<ImportResult> {
  const notes = new Notes();
  const written = "files" in input ? [] : fromReflection(input.reflection.file_descriptor_protos, notes);
  const sources = "files" in input ? input.files : written;
  const set = buildSet(sources, notes);
  return {
    ...toolsOf(set, notes),
    notes: notes.list,
    environments: [],
    auth: [],
    document_hash: bundleHash(sources),
    files: written,
    descriptor_set: set.descriptorSet,
  };
}

/**
 * SHA-256 of the definition as committed. One file hashes its text. Many
 * files hash one bundle, the list of { path, text } sorted by path and
 * written as formatted JSON, so the order the files arrive in never changes
 * the hash.
 */
function bundleHash(files: readonly ImportedFile[]): Sha256Digest {
  const [only] = files;
  if (files.length === 1 && only !== undefined) return documentHash(only.text);
  const bundle = [...files]
    .map(({ path, text }) => ({ path, text }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return documentHash(formatJson(bundle));
}
