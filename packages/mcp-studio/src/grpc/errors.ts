// errors.ts: the one error gRPC import throws, with a stable code.
//
// Every refusal says what happened and what to do. A caller branches on
// `code`, and on `file` when the refusal is about one file.

export type GrpcImportErrorCode =
  /** The files, or the reflection result, are over DEFINITION_BYTES_MAX. */
  | "too_large"
  /** The input holds no .proto file, or the reflection result holds no file. */
  | "empty"
  /** A path is empty, absolute, outside the folder, or does not end in .proto. */
  | "path"
  /** Two files take one name, or two definitions take one full name. */
  | "duplicate"
  /** A file does not parse as proto2 or proto3. */
  | "parse"
  /** A file uses what import does not read: an edition, a group, or an unknown option. */
  | "unsupported"
  /** A file imports a file that is not among the files or the well-known types. */
  | "import_missing"
  /** A chain of imports leads back to the file that starts it. */
  | "import_cycle"
  /** A type name does not name a message or an enum the file can see. */
  | "unresolved"
  /** The descriptors do not form a set the executor can load. */
  | "invalid"
  /** A reflection entry is not a FileDescriptorProto the printer can write as .proto text. */
  | "reflection"
  /** Import produced more schema nodes than its limit. */
  | "expansion_limit";

export class GrpcImportError extends Error {
  readonly code: GrpcImportErrorCode;
  /** The file the refusal is about, by its name in the descriptor set. */
  readonly file: string | undefined;

  constructor(code: GrpcImportErrorCode, message: string, file?: string) {
    super(message);
    this.name = "GrpcImportError";
    this.code = code;
    this.file = file;
  }
}
