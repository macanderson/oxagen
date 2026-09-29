// reflection.test.ts: fromReflection, which checks what server reflection
// returned and writes each file as .proto text under proto/.
//
// Each case encodes FileDescriptorProtos by hand, as a server would send
// them, so a test can send what no .proto file compiles to: a bad name, an
// unknown syntax, or two different files with one name.
import { clone, create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
  DescriptorProtoSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FileDescriptorProtoSchema,
  SourceCodeInfoSchema,
  file_google_protobuf_timestamp,
  type FileDescriptorProto,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { Notes } from "../graphql/notes";
import type { ImportedFile } from "../model/import-result";
import { DEFINITION_BYTES_MAX } from "../model/definition-limits";
import { GrpcImportError, importGrpc, type GrpcImportErrorCode } from "./index";
import { fromReflection } from "./reflection";

const T = FieldDescriptorProto_Type;
const L = FieldDescriptorProto_Label;
const TIMESTAMP = "google/protobuf/timestamp.proto";

type FileInit = MessageInitShape<typeof FileDescriptorProtoSchema>;

/** One FileDescriptorProto as reflection sends it. */
function encode(init: FileInit): Uint8Array {
  return toBinary(FileDescriptorProtoSchema, create(FileDescriptorProtoSchema, init));
}

/** A proto3 file with one message and nothing else. */
function plain(name: string, extra: FileInit = {}): Uint8Array {
  return encode({ name, syntax: "proto3", package: "p", messageType: [{ name: "M" }], ...extra });
}

/** The bundled timestamp.proto, as a server that compiled it with protoc returns it. */
function timestamp(): FileDescriptorProto {
  return clone(FileDescriptorProtoSchema, file_google_protobuf_timestamp.proto);
}

/** a.proto with one Timestamp field. */
const USES_TIMESTAMP = encode({
  name: "a.proto",
  syntax: "proto3",
  dependency: [TIMESTAMP],
  messageType: [
    {
      name: "M",
      field: [{ name: "at", jsonName: "at", number: 1, label: L.OPTIONAL, type: T.MESSAGE, typeName: ".google.protobuf.Timestamp" }],
    },
  ],
});

const USES_TIMESTAMP_TEXT = 'syntax = "proto3";\n\nimport "google/protobuf/timestamp.proto";\n\nmessage M {\n  google.protobuf.Timestamp at = 1;\n}\n';

interface Reflected {
  files: ImportedFile[];
  notes: Notes;
}

function reflect(protos: readonly Uint8Array[]): Reflected {
  const notes = new Notes();
  return { files: fromReflection(protos, notes), notes };
}

/** The refusal fromReflection throws for the result. */
function refusal(protos: readonly Uint8Array[]): GrpcImportError {
  try {
    fromReflection(protos, new Notes());
  } catch (error) {
    if (error instanceof GrpcImportError) return error;
    throw error;
  }
  throw new Error("fromReflection accepted the result.");
}

/** Checks the refusal's code, the file it names, and each part its message must hold. */
function expectRefusal(
  protos: readonly Uint8Array[],
  code: GrpcImportErrorCode,
  file: string | undefined,
  ...parts: string[]
): void {
  const error = refusal(protos);
  expect(error.code).toBe(code);
  expect(error.file).toBe(file);
  for (const part of parts) expect(error.message).toContain(part);
}

describe("fromReflection size", () => {
  it("refuses a result with no files", () => {
    expectRefusal(
      [],
      "empty",
      undefined,
      "Server reflection returned no files. Check that the server turns on reflection, or import its .proto files instead.",
    );
  });

  it("refuses a result whose entries come to over 25 MB together", () => {
    expectRefusal(
      [new Uint8Array(DEFINITION_BYTES_MAX), new Uint8Array(1)],
      "too_large",
      undefined,
      "Server reflection returned 26,214,401 bytes of descriptors. Import refuses a definition over 25 MB",
    );
  });

  it("reads a result of exactly 25 MB past the size check", () => {
    // Zero bytes do not decode, so the refusal comes from the decoder, not the size check.
    expectRefusal(
      [new Uint8Array(DEFINITION_BYTES_MAX)],
      "reflection",
      undefined,
      "Entry 1 of the reflection result is not a FileDescriptorProto: ",
    );
  });
});

describe("fromReflection entries", () => {
  it("refuses an entry that does not decode and counts entries from 1", () => {
    // Field 1 claims five bytes of name and holds one.
    const truncated = new Uint8Array([0x0a, 0x05, 0x61]);
    expectRefusal(
      [plain("a.proto"), truncated],
      "reflection",
      undefined,
      "Entry 2 of the reflection result is not a FileDescriptorProto: ",
      ". Check that the server runs gRPC reflection, or import its .proto files instead.",
    );
  });

  it("keeps one copy of a file reflection sends twice", () => {
    const { files } = reflect([plain("a.proto"), plain("a.proto")]);
    expect(files).toStrictEqual([{ path: "proto/a.proto", text: 'syntax = "proto3";\n\npackage p;\n\nmessage M {\n}\n' }]);
  });

  it("refuses two different files with one name", () => {
    expectRefusal(
      [plain("a.proto"), plain("a.proto", { package: "q" })],
      "duplicate",
      "a.proto",
      'Server reflection returned two different files named "a.proto". Import the server\'s .proto files instead.',
    );
  });

  it("writes the files in name order whatever order they arrive in", () => {
    const { files } = reflect([plain("z.proto", { package: "z" }), plain("a.proto")]);
    expect(files.map((file) => file.path)).toStrictEqual(["proto/a.proto", "proto/z.proto"]);
  });
});

describe("fromReflection names", () => {
  const badNames: [string, string][] = [
    ["an empty name", ""],
    ["an absolute path", "/a.proto"],
    ["a path that climbs out", "../a.proto"],
    ["a path with a dot segment", "./a.proto"],
    ["a path with a double slash", "a//b.proto"],
    ["a name that does not end in .proto", "a.txt"],
    ["a name with a quote", 'a".proto'],
    ["a name with a backslash", "a\\b.proto"],
    ["a name with a scheme", "c:/a.proto"],
    ["a name with a control character", `a${String.fromCharCode(1)}.proto`],
    ["a name with a delete character", `a${String.fromCharCode(0x7f)}.proto`],
  ];

  it.each(badNames)("refuses %s", (_label, name) => {
    expectRefusal(
      [plain(name)],
      "reflection",
      name,
      `Server reflection returned a file named ${JSON.stringify(name)}, which is not a path import can write under proto/. Import the server's .proto files instead.`,
    );
  });

  it("writes a file in a folder under proto/", () => {
    const { files } = reflect([plain("sub/dir/a.proto")]);
    expect(files.map((file) => file.path)).toStrictEqual(["proto/sub/dir/a.proto"]);
  });

  it("refuses an import path the folder cannot hold", () => {
    expectRefusal(
      [plain("a.proto", { dependency: ["../b.proto"] })],
      "reflection",
      "a.proto",
      `a.proto imports "../b.proto", which is not a path import can write under proto/. Import the server's .proto files instead.`,
    );
  });

  it("refuses an import reflection did not return", () => {
    expectRefusal(
      [plain("a.proto", { dependency: ["b.proto"] })],
      "import_missing",
      "a.proto",
      "a.proto imports b.proto, which server reflection did not return. Import the server's .proto files with every file they import instead.",
    );
  });
});

describe("fromReflection syntax", () => {
  it("refuses an edition as unsupported", () => {
    expectRefusal(
      [plain("a.proto", { syntax: "editions" })],
      "unsupported",
      "a.proto",
      "a.proto uses protobuf editions. Import reads proto2 and proto3 files, so import a proto3 or proto2 copy of the server's .proto files instead.",
    );
  });

  it("refuses a syntax it does not know", () => {
    expectRefusal(
      [plain("a.proto", { syntax: "proto4" })],
      "reflection",
      "a.proto",
      'a.proto declares the syntax "proto4", which is not proto2 or proto3. Import the server\'s .proto files instead.',
    );
  });

  it("writes a file that names proto2 and one that names no syntax as proto2", () => {
    // b.proto takes another package, because two files that define p.M are refused as a duplicate.
    const { files } = reflect([plain("a.proto", { syntax: "proto2" }), plain("b.proto", { syntax: "", package: "q" })]);
    expect(files).toStrictEqual([
      { path: "proto/a.proto", text: 'syntax = "proto2";\n\npackage p;\n\nmessage M {\n}\n' },
      { path: "proto/b.proto", text: 'syntax = "proto2";\n\npackage q;\n\nmessage M {\n}\n' },
    ]);
  });
});

describe("fromReflection well-known types", () => {
  it("leaves out a well-known type equal to the standard file, with no note", () => {
    const withComment = timestamp();
    withComment.sourceCodeInfo = create(SourceCodeInfoSchema, {
      location: [{ path: [4, 0], leadingComments: "A point in time." }],
    });
    for (const reflected of [timestamp(), withComment]) {
      const { files, notes } = reflect([USES_TIMESTAMP, toBinary(FileDescriptorProtoSchema, reflected)]);
      expect(files).toStrictEqual([{ path: "proto/a.proto", text: USES_TIMESTAMP_TEXT }]);
      expect(notes.list).toStrictEqual([]);
    }
  });

  it("notes a well-known type that differs from the standard file, and uses the standard file", () => {
    const changed = timestamp();
    changed.messageType.push(create(DescriptorProtoSchema, { name: "Extra" }));
    const { files, notes } = reflect([USES_TIMESTAMP, toBinary(FileDescriptorProtoSchema, changed)]);
    expect(files).toStrictEqual([{ path: "proto/a.proto", text: USES_TIMESTAMP_TEXT }]);
    expect(notes.list).toStrictEqual([
      {
        tool: undefined,
        message:
          "Server reflection returned google/protobuf/timestamp.proto with definitions that differ from the standard file. Import uses the standard file.",
      },
    ]);
  });

  it("refuses a result that holds only well-known types", () => {
    expectRefusal(
      [toBinary(FileDescriptorProtoSchema, timestamp())],
      "empty",
      undefined,
      "Server reflection returned only well-known types, so it holds no service to import. Import the server's .proto files instead.",
    );
  });

  it("resolves a type through well-known types that only another well-known type imports", () => {
    // api.proto imports type.proto and source_context.proto, and type.proto imports any.proto.
    const usesApi = encode({
      name: "a.proto",
      syntax: "proto3",
      dependency: ["google/protobuf/api.proto"],
      messageType: [
        {
          name: "M",
          field: [{ name: "api", jsonName: "api", number: 1, label: L.OPTIONAL, type: T.MESSAGE, typeName: ".google.protobuf.Api" }],
        },
      ],
    });
    const { files, notes } = reflect([usesApi]);
    expect(files).toStrictEqual([
      {
        path: "proto/a.proto",
        text: 'syntax = "proto3";\n\nimport "google/protobuf/api.proto";\n\nmessage M {\n  google.protobuf.Api api = 1;\n}\n',
      },
    ]);
    expect(notes.list).toStrictEqual([]);
  });
});

describe("importGrpc with a reflected import cycle", () => {
  const a = encode({ name: "a.proto", dependency: ["b.proto"], publicDependency: [0] });
  const b = encode({ name: "b.proto", dependency: ["a.proto"], publicDependency: [0] });

  it("writes both files, because reflection checks names and not the import graph", () => {
    const { files } = reflect([a, b]);
    expect(files).toStrictEqual([
      { path: "proto/a.proto", text: 'syntax = "proto2";\n\nimport public "b.proto";\n' },
      { path: "proto/b.proto", text: 'syntax = "proto2";\n\nimport public "a.proto";\n' },
    ]);
  });

  it("refuses the cycle when it reads the written files back", async () => {
    let error: unknown;
    try {
      await importGrpc({ reflection: { file_descriptor_protos: [a, b] } });
    } catch (caught) {
      error = caught;
    }
    if (!(error instanceof GrpcImportError)) throw new Error("importGrpc accepted the cycle.");
    expect(error.code).toBe("import_cycle");
    expect(error.file).toBe("a.proto");
    expect(error.message).toContain("The imports form a cycle: a.proto imports b.proto and b.proto imports a.proto.");
  });
});
