// reflection.ts: what server reflection returned, as .proto files under
// proto/.
//
// Reflection returns serialized FileDescriptorProtos. Import writes each one
// back as .proto text (print.ts), so a server imported by reflection commits
// the same kind of folder as a server imported from its files, and buildSet
// reads both the same way. A well-known type reflection returns is not
// written: buildSet takes it from @bufbuild/protobuf like any other import.
import { clone, equals, fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, type FileDescriptorProto } from "@bufbuild/protobuf/wkt";
import type { Notes } from "../graphql/notes";
import type { ImportedFile } from "../model/import-result";
import { normalizePath } from "../openapi/ref-path";
import { GrpcImportError } from "./errors";
import { count, DEFINITION_BYTES_MAX, messageOf } from "./limits";
import { printProto } from "./print";
import { PROTO_DIR, Visibility } from "./set";
import { Symbols } from "./symbols";
import { bundledWkt, isBundledWkt } from "./wkt";

/**
 * Each file reflection returned, other than a well-known type, as
 * { path: "proto/<name>", text } in name order. Refuses an empty or
 * oversized result, an entry that does not decode, two different files with
 * one name, a name the folder cannot hold, an edition, and an import
 * reflection did not return.
 */
export function fromReflection(protos: readonly Uint8Array[], notes: Notes): ImportedFile[] {
  if (protos.length === 0) {
    throw new GrpcImportError(
      "empty",
      "Server reflection returned no files. Check that the server turns on reflection, or import its .proto files instead.",
    );
  }
  const bytes = protos.reduce((sum, proto) => sum + proto.byteLength, 0);
  if (bytes > DEFINITION_BYTES_MAX) {
    throw new GrpcImportError(
      "too_large",
      `Server reflection returned ${count(bytes)} bytes of descriptors. Import refuses a definition over 25 MB, so import the .proto files the services need instead.`,
    );
  }

  const reflected = decodeAll(protos);
  for (const file of reflected.values()) checkFile(file, reflected);

  const effective = effectiveFiles(reflected);
  const symbols = new Symbols();
  for (const file of effective) symbols.register(file);
  const visibility = new Visibility(effective);

  const written: ImportedFile[] = [];
  for (const [name, file] of [...reflected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (isBundledWkt(name)) {
      noteChangedWkt(file, notes);
      continue;
    }
    written.push({ path: `${PROTO_DIR}${name}`, text: printProto(file, symbols, visibility.of(name), notes) });
  }
  if (written.length === 0) {
    throw new GrpcImportError(
      "empty",
      "Server reflection returned only well-known types, so it holds no service to import. Import the server's .proto files instead.",
    );
  }
  return written;
}

/** Every entry decoded, by name. An entry reflection sent twice is kept once. */
function decodeAll(protos: readonly Uint8Array[]): Map<string, FileDescriptorProto> {
  const byName = new Map<string, FileDescriptorProto>();
  protos.forEach((bytes, index) => {
    let file: FileDescriptorProto;
    try {
      file = fromBinary(FileDescriptorProtoSchema, bytes);
    } catch (error) {
      throw new GrpcImportError(
        "reflection",
        `Entry ${index + 1} of the reflection result is not a FileDescriptorProto: ${messageOf(error)}. Check that the server runs gRPC reflection, or import its .proto files instead.`,
      );
    }
    const earlier = byName.get(file.name);
    if (earlier === undefined) byName.set(file.name, file);
    else if (!equals(FileDescriptorProtoSchema, earlier, file)) {
      throw new GrpcImportError(
        "duplicate",
        `Server reflection returned two different files named ${quoted(file.name)}. Import the server's .proto files instead.`,
        file.name,
      );
    }
  });
  return byName;
}

/** The file's name, its imports, and its syntax are ones the printed folder can hold. */
function checkFile(file: FileDescriptorProto, reflected: ReadonlyMap<string, FileDescriptorProto>): void {
  checkName(file.name, `Server reflection returned a file named ${quoted(file.name)}`, file.name);
  for (const dependency of file.dependency) {
    checkName(dependency, `${file.name} imports ${quoted(dependency)}`, file.name);
    if (!reflected.has(dependency) && !isBundledWkt(dependency)) {
      throw new GrpcImportError(
        "import_missing",
        `${file.name} imports ${dependency}, which server reflection did not return. Import the server's .proto files with every file they import instead.`,
        file.name,
      );
    }
  }
  if (file.syntax === "editions") {
    throw new GrpcImportError(
      "unsupported",
      `${file.name} uses protobuf editions. Import reads proto2 and proto3 files, so import a proto3 or proto2 copy of the server's .proto files instead.`,
      file.name,
    );
  }
  if (file.syntax !== "" && file.syntax !== "proto2" && file.syntax !== "proto3") {
    throw new GrpcImportError(
      "reflection",
      `${file.name} declares the syntax ${quoted(file.syntax)}, which is not proto2 or proto3. Import the server's .proto files instead.`,
      file.name,
    );
  }
}

/**
 * A name must be a path under proto/ that import can write between quotes:
 * already normalized, ending in .proto, with no quote, backslash, or control
 * character.
 */
function checkName(name: string, what: string, file: string): void {
  const plain = name !== "" && normalizePath(name) === name && name.endsWith(".proto") && !hasUnsafeCharacter(name);
  if (!plain) {
    throw new GrpcImportError(
      "reflection",
      `${what}, which is not a path import can write under proto/. Import the server's .proto files instead.`,
      file,
    );
  }
}

/** A quote, a backslash, or a control character, none of which a printed import path may hold. */
function hasUnsafeCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x22 || code === 0x5c) return true;
  }
  return false;
}

/**
 * Every file the printer resolves names against: each reflected file, with
 * the bundled copy in place of a well-known type, and every well-known type
 * those import that reflection left out.
 */
function effectiveFiles(reflected: ReadonlyMap<string, FileDescriptorProto>): FileDescriptorProto[] {
  const files = new Map<string, FileDescriptorProto>();
  const pending: string[] = [];
  for (const [name, file] of reflected) {
    const bundled = bundledWkt(name);
    files.set(name, bundled ?? file);
    pending.push(...(bundled ?? file).dependency);
  }
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (files.has(name)) continue;
    const bundled = bundledWkt(name);
    if (bundled === undefined) continue;
    files.set(name, bundled);
    pending.push(...bundled.dependency);
  }
  return [...files.values()];
}

/** Notes a reflected well-known type whose definitions differ from the standard file import uses. */
function noteChangedWkt(file: FileDescriptorProto, notes: Notes): void {
  const standard = bundledWkt(file.name);
  if (standard === undefined) return;
  const returned = clone(FileDescriptorProtoSchema, file);
  returned.sourceCodeInfo = undefined;
  standard.sourceCodeInfo = undefined;
  if (equals(FileDescriptorProtoSchema, returned, standard)) return;
  notes.add(
    undefined,
    `Server reflection returned ${file.name} with definitions that differ from the standard file. Import uses the standard file.`,
  );
}

/** A name as a refusal quotes it, with any control character escaped. */
function quoted(text: string): string {
  return JSON.stringify(text);
}
