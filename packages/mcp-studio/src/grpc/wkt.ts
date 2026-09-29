// wkt.ts: the well-known types import supplies when the folder lacks them.
//
// A proto that imports google/protobuf/timestamp.proto rarely ships that file:
// protoc carries it, and buf takes it from its own copy. Import takes it from
// @bufbuild/protobuf, whose compiled descriptors match protoc's for each file
// below, so a descriptor set built with them equals the one buf builds. The
// editions feature files (cpp_features.proto and the like) are left out,
// because import reads proto2 and proto3 files only.
import { clone, type DescFile } from "@bufbuild/protobuf";
import {
  FileDescriptorProtoSchema,
  file_google_protobuf_any,
  file_google_protobuf_api,
  file_google_protobuf_compiler_plugin,
  file_google_protobuf_descriptor,
  file_google_protobuf_duration,
  file_google_protobuf_empty,
  file_google_protobuf_field_mask,
  file_google_protobuf_source_context,
  file_google_protobuf_struct,
  file_google_protobuf_timestamp,
  file_google_protobuf_type,
  file_google_protobuf_wrappers,
  type FileDescriptorProto,
} from "@bufbuild/protobuf/wkt";

const BUNDLED = new Map<string, DescFile>(
  [
    file_google_protobuf_any,
    file_google_protobuf_api,
    file_google_protobuf_compiler_plugin,
    file_google_protobuf_descriptor,
    file_google_protobuf_duration,
    file_google_protobuf_empty,
    file_google_protobuf_field_mask,
    file_google_protobuf_source_context,
    file_google_protobuf_struct,
    file_google_protobuf_timestamp,
    file_google_protobuf_type,
    file_google_protobuf_wrappers,
  ].map((file) => [file.proto.name, file]),
);

/** Whether import can supply this file, such as google/protobuf/timestamp.proto. */
export function isBundledWkt(name: string): boolean {
  return BUNDLED.has(name);
}

/** A copy of the bundled file's descriptor, or undefined when import does not carry it. */
export function bundledWkt(name: string): FileDescriptorProto | undefined {
  const file = BUNDLED.get(name);
  return file === undefined ? undefined : clone(FileDescriptorProtoSchema, file.proto);
}
