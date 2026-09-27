// grpc: a protobuf package as UpstreamTool[] (lane M3; mcp-studio-spec,
// Definition import and Mapping).
//
// Each unary and server-streaming method becomes one tool, with its input
// and output schemas by the proto3 JSON mapping. Client and bidirectional
// streams are listed and never become tools.
import type { ImportedFile, ImportResult } from "../model/import-result";
import { notBuiltAsync } from "../not-built";

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
export function importGrpc(input: GrpcInput): Promise<ImportResult> {
  return notBuiltAsync("grpc", input);
}
