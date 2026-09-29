// print.test.ts: printProto, which writes a reflected FileDescriptorProto as
// .proto text, checked by reading the text back with buildSet.
//
// Each case builds a descriptor from .proto text, changes it where a server
// could send something the text cannot say, prints it, and reads the print
// back. A round trip must give the same descriptor. A case the printer cannot
// write exactly must add a note or refuse with a message that says what to do.
import { clearField, clone, create, equals, fromBinary, toJson } from "@bufbuild/protobuf";
import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import {
  DescriptorProtoSchema,
  DescriptorProto_ExtensionRangeSchema,
  DescriptorProto_ReservedRangeSchema,
  EnumDescriptorProto_EnumReservedRangeSchema,
  ExtensionRangeOptionsSchema,
  FieldDescriptorProtoSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FileDescriptorProtoSchema,
  FileOptionsSchema,
  MessageOptionsSchema,
  MethodOptionsSchema,
  OneofDescriptorProtoSchema,
  SourceCodeInfoSchema,
  type DescriptorProto,
  type FieldDescriptorProto,
  type FileDescriptorProto,
  type MethodDescriptorProto,
  type MethodOptions_IdempotencyLevel,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { Notes } from "../graphql/notes";
import type { ImportedFile } from "../model/import-result";
import { GrpcImportError } from "./errors";
import { printProto } from "./print";
import { buildSet, Visibility } from "./set";
import { Symbols } from "./symbols";

const A = "a.proto";
const T = FieldDescriptorProto_Type;
const L = FieldDescriptorProto_Label;

interface Printed {
  text: string;
  notes: string[];
}

/** The item at the index, or a thrown error that names the index. */
function at<V>(list: readonly V[], index: number): V {
  const item = list[index];
  if (item === undefined) throw new Error(`The list has no item at index ${index}.`);
  return item;
}

/** The descriptors buildSet makes from a.proto and the other files, each under proto/. */
function filesOf(text: string, others: Readonly<Record<string, string>> = {}): FileDescriptorProto[] {
  const input: ImportedFile[] = [
    { path: `proto/${A}`, text },
    ...Object.entries(others).map(([name, body]) => ({ path: `proto/${name}`, text: body })),
  ];
  return buildSet(input, new Notes()).files;
}

function fileNamed(files: readonly FileDescriptorProto[], name = A): FileDescriptorProto {
  const file = files.find((each) => each.name === name);
  if (file === undefined) throw new Error(`No file is named ${name}.`);
  return file;
}

/** Prints the named file against every file, as reflection.ts does, and returns the text and each note's message. */
function print(files: readonly FileDescriptorProto[], name = A): Printed {
  const symbols = new Symbols();
  for (const file of files) symbols.register(file);
  const notes = new Notes();
  const text = printProto(fileNamed(files, name), symbols, new Visibility(files).of(name), notes);
  return { text, notes: notes.list.map((note) => note.message) };
}

/** The files with a changed copy of the named file in its place. */
function mutated(
  files: readonly FileDescriptorProto[],
  mutate: (file: FileDescriptorProto) => void,
  name = A,
): FileDescriptorProto[] {
  return files.map((file) => {
    if (file.name !== name) return file;
    const copy = clone(FileDescriptorProtoSchema, file);
    mutate(copy);
    return copy;
  });
}

/**
 * Checks that two descriptors are equal, leaving out source info. toJson
 * gives a readable diff, and equals also compares what JSON does not show.
 */
function expectSameFile(actual: FileDescriptorProto, expected: FileDescriptorProto): void {
  const left = clone(FileDescriptorProtoSchema, actual);
  const right = clone(FileDescriptorProtoSchema, expected);
  left.sourceCodeInfo = undefined;
  right.sourceCodeInfo = undefined;
  expect(toJson(FileDescriptorProtoSchema, left)).toStrictEqual(toJson(FileDescriptorProtoSchema, right));
  expect(equals(FileDescriptorProtoSchema, left, right)).toBe(true);
}

/** Prints a.proto, reads the text back with the other files, and checks the read equals `expected`. */
function expectReadsBackAs(
  files: readonly FileDescriptorProto[],
  expected: FileDescriptorProto,
  others: Readonly<Record<string, string>> = {},
): Printed {
  const printed = print(files);
  expectSameFile(fileNamed(filesOf(printed.text, others)), expected);
  return printed;
}

/** Prints a.proto and checks the text reads back to the same descriptor. */
function expectRoundTrip(files: readonly FileDescriptorProto[], others: Readonly<Record<string, string>> = {}): Printed {
  return expectReadsBackAs(files, fileNamed(files), others);
}

/** The refusal printProto throws for a.proto. */
function printRefusal(files: readonly FileDescriptorProto[]): GrpcImportError {
  try {
    print(files);
  } catch (error) {
    if (error instanceof GrpcImportError) return error;
    throw error;
  }
  throw new Error("printProto wrote the file.");
}

/** A note the printer adds when the text leaves something out. */
function leftOut(what: string): string {
  return `The .proto text import writes for a.proto leaves out ${what}.`;
}

/** The message of a "reflection" refusal. */
function refusalText(detail: string): string {
  return `Import cannot write a.proto from server reflection as .proto text: ${detail}. Import the server's .proto files instead.`;
}

/** A type number the enum does not declare, as a server could send it. */
function typeNumber(value: number): FieldDescriptorProto_Type {
  return value as FieldDescriptorProto_Type;
}

function idempotency(value: number): MethodOptions_IdempotencyLevel {
  return value as MethodOptions_IdempotencyLevel;
}

function messageAt(file: FileDescriptorProto, index = 0): DescriptorProto {
  return at(file.messageType, index);
}

function fieldAt(file: FileDescriptorProto, index = 0): FieldDescriptorProto {
  return at(messageAt(file).field, index);
}

function methodAt(file: FileDescriptorProto): MethodDescriptorProto {
  return at(at(file.service, 0).method, 0);
}

function field(init: {
  name: string;
  number: number;
  type: FieldDescriptorProto_Type;
  label?: FieldDescriptorProto_Label;
  extendee?: string;
  oneofIndex?: number;
  proto3Optional?: boolean;
}): FieldDescriptorProto {
  const { name, ...rest } = init;
  return create(FieldDescriptorProtoSchema, { name, jsonName: name, label: L.OPTIONAL, ...rest });
}

const B_PROTO = `syntax = "proto2";
package p.v1;
message FromB { optional int32 x = 1; }
`;

const C_PROTO = `syntax = "proto2";
package other;
message Weak {}
`;

const PROTO2 = `syntax = "proto2";
package p.v1;
import public "b.proto";
import weak "c.proto";
import "google/protobuf/timestamp.proto";
option java_package = "com.example.p";
option deprecated = true;

message Thing {
  option deprecated = true;
  required string id = 1;
  optional string name = 2 [default = 'say "hi"'];
  optional bytes blob = 3 [default = "abc"];
  optional float ratio = 4 [default = 1.5];
  optional double low = 5 [default = -inf];
  optional double odd = 6 [default = nan];
  optional int64 small = 7 [default = -5];
  optional uint64 big = 8 [default = 9007199254740991];
  optional bool flag = 9 [default = true];
  optional Color color = 10 [default = BLUE];
  repeated int32 nums = 11 [packed = true];
  optional string label = 12 [json_name = "renamed"];
  optional int32 old = 13 [deprecated = true];
  optional google.protobuf.Timestamp at = 14;
  optional Inner inner = 15;
  map<string, Inner> by_id = 16;
  oneof choice {
    string a = 17;
    int32 b = 18;
  }
  optional int32 limit = 19 [default = 10, deprecated = true];
  optional FromB from_b = 20;
  optional other.Weak weak_ref = 21;
  repeated Inner list = 22;
  message Inner { optional int32 n = 1; }
  enum Color {
    option allow_alias = true;
    RED = 0;
    BLUE = 1;
    AZURE = 1 [deprecated = true];
    NEGATIVE = -1;
    reserved 3, 5 to max;
    reserved "GREEN";
  }
  extensions 100 to 199, 500, 1000 to max;
  reserved 30 to 32, 35;
  reserved "gone", "went";
}

message Holder {
  extend Other { optional int32 held = 150; }
}

extend Thing {
  optional string note = 100;
  repeated int32 counts = 101;
}

extend Other { optional bool flag = 100; }

extend Thing { optional int32 more = 102; }

message Other { extensions 100 to 200; }

enum Level {
  LOW = 1;
  HIGH = 2;
}
`;

const PROTO3 = `syntax = "proto3";
package p;
import "google/protobuf/empty.proto";

service S {
  option deprecated = true;
  rpc Get(Thing) returns (Thing) { option idempotency_level = NO_SIDE_EFFECTS; }
  rpc Watch(Thing) returns (stream Thing);
  rpc Upload(stream Thing) returns (google.protobuf.Empty) { option deprecated = true; }
  rpc Chat(stream Thing) returns (stream Thing);
}

message Thing {
  optional string maybe = 1;
  oneof choice {
    string a = 2;
    int32 b = 3;
  }
  repeated string tags = 4;
  map<int64, string> names = 5;
  Kind kind = 6;
  enum Kind {
    KIND_UNSPECIFIED = 0;
    KIND_ONE = 1;
  }
}

enum Level {
  LEVEL_UNSPECIFIED = 0;
  LEVEL_HIGH = 1;
}
`;

/** A proto3 file with one service, one message, and one enum, for the refusals. */
const BASE = `syntax = "proto3";
package p;
service S { rpc Get(M) returns (M); }
message M { string a = 1; }
enum E { E_UNSPECIFIED = 0; }
`;

describe("printProto round trips", () => {
  it("writes a proto2 file that reads back to the same descriptor", () => {
    const others = { "b.proto": B_PROTO, "c.proto": C_PROTO };
    const printed = expectRoundTrip(filesOf(PROTO2, others), others);
    expect(printed.notes).toStrictEqual([]);
    expect(printed.text).toContain('import public "b.proto";\nimport weak "c.proto";\n');
    expect(printed.text).toContain(`  optional string name = 2 [default = 'say "hi"'];`);
    expect(printed.text).toContain("  map<string, Inner> by_id = 16;");
    expect(printed.text).toContain("  repeated Inner list = 22;");
    expect(printed.text).toContain("  extensions 100 to 199, 500, 1000 to 536870911;");
    expect(printed.text).toContain("  reserved 30 to 32, 35;");
    expect(printed.text).toContain("    reserved 3, 5 to max;");
    expect(printed.text).toContain("message Holder {\n  extend Other {\n    optional int32 held = 150;\n  }\n}");
  });

  it("writes a proto3 file with streams, a proto3 optional field, and a map", () => {
    const printed = expectRoundTrip(filesOf(PROTO3));
    expect(printed.notes).toStrictEqual([]);
    expect(printed.text).toContain("  rpc Watch(Thing) returns (stream Thing);");
    expect(printed.text).toContain("  rpc Chat(stream Thing) returns (stream Thing);");
    expect(printed.text).toContain("  rpc Upload(stream Thing) returns (google.protobuf.Empty) {\n    option deprecated = true;\n  }");
    expect(printed.text).toContain("  optional string maybe = 1;");
    expect(printed.text).toContain("  map<int64, string> names = 5;");
  });

  it("writes a small proto3 file exactly", () => {
    const printed = expectRoundTrip(filesOf('syntax = "proto3"; message A { B b = 1; } message B {}'));
    expect(printed.text).toBe('syntax = "proto3";\n\nmessage A {\n  B b = 1;\n}\n\nmessage B {\n}\n');
  });

  it("writes a package, a method option, a repeated field, and an enum exactly", () => {
    const source =
      'syntax="proto3"; package p; service S { rpc Get(Req) returns (Req) { option idempotency_level = IDEMPOTENT; } } message Req { repeated string ids = 1; } enum E { E_UNSPECIFIED = 0; }';
    const printed = expectRoundTrip(filesOf(source));
    expect(printed.text).toBe(
      'syntax = "proto3";\n\npackage p;\n\nservice S {\n  rpc Get(Req) returns (Req) {\n    option idempotency_level = IDEMPOTENT;\n  }\n}\n\nmessage Req {\n  repeated string ids = 1;\n}\n\nenum E {\n  E_UNSPECIFIED = 0;\n}\n',
    );
  });

  it("writes a proto3 extension with no label and a repeated one", () => {
    const source = `syntax = "proto3";
package p;
import "google/protobuf/descriptor.proto";
extend google.protobuf.MessageOptions {
  int32 x = 50000;
  repeated string y = 50001;
}
`;
    const printed = expectRoundTrip(filesOf(source));
    expect(printed.text).toContain("extend google.protobuf.MessageOptions {\n  int32 x = 50000;\n  repeated string y = 50001;\n}");
  });

  it("writes a map field whose entry comes before the other nested messages", () => {
    const files = filesOf('syntax = "proto3"; message M { map<string, Inner> tags = 1; message Inner {} }');
    const reordered = mutated(files, (file) => {
      messageAt(file).nestedType.reverse();
    });
    expect(messageAt(fileNamed(reordered)).nestedType.map((each) => each.name)).toStrictEqual(["TagsEntry", "Inner"]);
    const printed = expectReadsBackAs(reordered, fileNamed(files));
    expect(printed.text).toContain("  map<string, Inner> tags = 1;");
  });

  it("writes a field whose type is unset from the kind its name resolves to", () => {
    const files = filesOf(
      'syntax = "proto3"; message M { Inner inner = 1; Kind kind = 2; } message Inner {} enum Kind { KIND_UNSPECIFIED = 0; }',
    );
    const unset = mutated(files, (file) => {
      clearField(fieldAt(file, 0), FieldDescriptorProtoSchema.field.type);
      clearField(fieldAt(file, 1), FieldDescriptorProtoSchema.field.type);
      clearField(fieldAt(file, 1), FieldDescriptorProtoSchema.field.jsonName);
    });
    const printed = expectReadsBackAs(unset, fileNamed(files));
    expect(printed.text).toContain("  Inner inner = 1;\n  Kind kind = 2;");
  });

  it("writes a oneof at its first field when its fields are not next to each other", () => {
    const files = filesOf('syntax = "proto3"; message M { oneof o { string a = 1; string b = 3; } string c = 2; }');
    const split = mutated(files, (file) => {
      const [a, b, c] = messageAt(file).field;
      if (a === undefined || b === undefined || c === undefined) throw new Error("M has three fields.");
      messageAt(file).field = [a, c, b];
    });
    // The printer moves b next to a, so the read gives protoc's order back.
    const printed = expectReadsBackAs(split, fileNamed(files));
    expect(printed.text).toContain("  oneof o {\n    string a = 1;\n    string b = 3;\n  }\n  string c = 2;");
  });

  it("writes messages named like map entries as plain messages", () => {
    const source = `syntax = "proto3";
message M {
  message TagsEntry { string key = 1; string value = 2; }
  message ItemsEntry { option deprecated = true; string key = 1; }
  repeated TagsEntry tags = 1;
  repeated ItemsEntry items = 2;
}
`;
    const printed = expectRoundTrip(filesOf(source));
    expect(printed.text).toContain("  repeated TagsEntry tags = 1;\n  repeated ItemsEntry items = 2;");
  });
});

describe("printProto type names", () => {
  it("writes a name longer when its last part is a keyword", () => {
    const files = mutated(filesOf('syntax = "proto3"; package p; message A { B b = 1; } message B {}'), (file) => {
      messageAt(file, 1).name = "stream";
      fieldAt(file).typeName = ".p.stream";
    });
    const printed = expectRoundTrip(files);
    expect(printed.text).toContain("  p.stream b = 1;");
  });

  it("writes the full name with its leading dot when every shorter name is a keyword", () => {
    const files = mutated(filesOf('syntax = "proto3"; message A { B b = 1; } message B {}'), (file) => {
      messageAt(file, 1).name = "stream";
      fieldAt(file).typeName = ".stream";
    });
    const printed = expectRoundTrip(files);
    expect(printed.text).toContain("  .stream b = 1;");
  });

  it("writes the full name when a nested definition shadows every shorter one", () => {
    const files = filesOf('syntax = "proto3"; package p; message A {} message C { message A {} message p {} .p.A a = 1; }');
    const printed = expectRoundTrip(files);
    expect(printed.text).toContain("  .p.A a = 1;");
  });
});

describe("printProto strings", () => {
  const proto2 = 'syntax = "proto2"; package p; message M { optional string s = 1; }';

  it("splits a string default that holds both quote characters into adjacent literals", () => {
    const files = mutated(filesOf(proto2), (file) => {
      fieldAt(file).defaultValue = `it's "x"`;
    });
    const printed = expectRoundTrip(files);
    expect(printed.text).toContain(`  optional string s = 1 [default = "it's " '"x"'];`);
    expect(printed.notes).toStrictEqual([]);
  });

  it("escapes a backslash, a tab, a newline, a carriage return, and a null in an option", () => {
    const value = `path\\to "x" it's\t` + "\n\r\0";
    const files = mutated(filesOf(BASE), (file) => {
      file.options = create(FileOptionsSchema, { goPackage: value });
    });
    const printed = expectRoundTrip(files);
    expect(printed.text).toContain(String.raw`option go_package = 'path\\to "x" it' "'s\t\n\r\0";`);
  });

  it("writes a JSON name with a tab as an escape", () => {
    const files = mutated(filesOf(BASE), (file) => {
      fieldAt(file).jsonName = "a\tb";
    });
    const printed = expectRoundTrip(files);
    expect(printed.text).toContain(String.raw`  string a = 1 [json_name = "a\tb"];`);
  });
});

describe("printProto comments", () => {
  const source = `syntax = "proto2";
package p;
service S { rpc Get(M) returns (M); }
message M {
  optional int32 a = 1;
  oneof o { int32 b = 2; }
  map<string, int32> tags = 3;
  message Inner { optional int32 n = 1; }
  enum Kind { KIND_ZERO = 0; }
  extend Other { optional int32 nested_ext = 100; }
}
message Other { extensions 100 to 200; }
enum E { E_ZERO = 0; }
extend Other { optional int32 top_ext = 101; }
`;

  /** Each SourceCodeInfo path with its leading comment. The first of two comments on one path wins. */
  const locations: [number[], string][] = [
    [[6, 0], "   \n  "],
    [[6, 0], "The service."],
    [[6, 0], "Ignored."],
    [[6, 0, 2, 0], "Line one.\r\nLine two."],
    [[4, 0], "* Starts with a star.\n   Indented line.\n\nLast line.\n"],
    [[4, 0, 2, 0], "/path/to/thing"],
    [[4, 0, 8, 0], "The oneof."],
    [[4, 0, 2, 1], "Field b."],
    [[4, 0, 2, 2], "The tags."],
    [[4, 0, 3, 0], "Inner message."],
    [[4, 0, 3, 0, 2, 0], "Inner field."],
    [[4, 0, 4, 0], "The kind."],
    [[4, 0, 4, 0, 2, 0], "Zero kind."],
    [[4, 0, 6, 0], "Nested extension."],
    [[4, 1], "\n\nOther message.\n\n"],
    [[5, 0], "The enum."],
    [[5, 0, 2, 0], "Zero."],
    [[7, 0], "Top extension."],
  ];

  it("writes each leading comment where protobufjs reads it back", () => {
    const files = filesOf(source);
    const commented = mutated(files, (file) => {
      file.sourceCodeInfo = create(SourceCodeInfoSchema, {
        location: locations.map(([path, leadingComments]) => ({ path, leadingComments })),
      });
    });
    const printed = print(commented);
    const back = buildSet([{ path: `proto/${A}`, text: printed.text }], new Notes());
    expect(Object.fromEntries(back.comments)).toStrictEqual({
      "p.S": "The service.",
      "p.S.Get": "Line one.\nLine two.",
      "p.M": "* Starts with a star.\nIndented line.\n\nLast line.",
      "p.M.a": "/path/to/thing",
      "p.M.o": "The oneof.",
      "p.M.b": "Field b.",
      "p.M.tags": "The tags.",
      "p.M.Inner": "Inner message.",
      "p.M.Inner.n": "Inner field.",
      "p.M.Kind": "The kind.",
      "p.M.Kind.KIND_ZERO": "Zero kind.",
      "p.M.nested_ext": "Nested extension.",
      "p.Other": "Other message.",
      "p.E": "The enum.",
      "p.E.E_ZERO": "Zero.",
      "p.top_ext": "Top extension.",
    });
    expect(printed.text).toContain("\n//\n// * Starts with a star.\n// Indented line.\n//\n// Last line.\nmessage M {\n");
    expect(printed.text).toContain("  //\n  // /path/to/thing\n  optional int32 a = 1;");
    expectSameFile(fileNamed(back.files), fileNamed(files));
  });
});

interface RefusalCase {
  name: string;
  source?: string;
  others?: Record<string, string>;
  mutate: (file: FileDescriptorProto) => void;
  detail: string;
}

/** Adds the oneof o to M and puts M.a in it. */
function oneofWithA(file: FileDescriptorProto, name = "o"): FieldDescriptorProto {
  messageAt(file).oneofDecl.push(create(OneofDescriptorProtoSchema, { name }));
  const a = fieldAt(file);
  a.oneofIndex = 0;
  return a;
}

const NOT_IDENTIFIER = ", which is not a valid .proto identifier";

const refusals: RefusalCase[] = [
  {
    name: "a package part that is not an identifier",
    mutate: (file) => {
      file.package = "p.1v";
    },
    detail: `a part of the package name "p.1v" is named "1v"${NOT_IDENTIFIER}`,
  },
  {
    name: "a public import number past the imports",
    mutate: (file) => {
      file.publicDependency = [3];
    },
    detail: "it marks import number 3 public or weak, and it has 0 imports",
  },
  {
    name: "an import both public and weak",
    mutate: (file) => {
      file.dependency = ["google/protobuf/empty.proto"];
      file.publicDependency = [0];
      file.weakDependency = [0];
    },
    detail: "it marks its import of google/protobuf/empty.proto both public and weak",
  },
  {
    name: "a service name that is not an identifier",
    mutate: (file) => {
      at(file.service, 0).name = "1S";
    },
    detail: `a service is named "1S"${NOT_IDENTIFIER}`,
  },
  {
    name: "a method name that is not an identifier",
    mutate: (file) => {
      methodAt(file).name = "get-it";
    },
    detail: `a method of p.S is named "get-it"${NOT_IDENTIFIER}`,
  },
  {
    name: "an input type that is not a full name",
    mutate: (file) => {
      methodAt(file).inputType = "M";
    },
    detail: 'the input of the method p.S.Get is "M", which is not a full type name',
  },
  {
    name: "an output type that is not a valid name",
    mutate: (file) => {
      methodAt(file).outputType = ".p.1M";
    },
    detail: 'the output of the method p.S.Get is ".p.1M", which is not a valid type name',
  },
  {
    name: "an input type that names an enum",
    mutate: (file) => {
      methodAt(file).inputType = ".p.E";
    },
    detail: "the input of the method p.S.Get is .p.E, which is not a message that a.proto or its imports define",
  },
  {
    name: "a message name that is not an identifier",
    mutate: (file) => {
      file.service = [];
      messageAt(file).name = "1M";
    },
    detail: `a message is named "1M"${NOT_IDENTIFIER}`,
  },
  {
    name: "a map entry no map field uses",
    mutate: (file) => {
      messageAt(file).nestedType.push(create(DescriptorProtoSchema, { name: "XEntry", options: { mapEntry: true } }));
    },
    detail: "the message p.M.XEntry is a map entry that no map field in the same message uses",
  },
  {
    name: "a proto3 optional field in no oneof",
    mutate: (file) => {
      fieldAt(file).proto3Optional = true;
    },
    detail: "the field p.M.a is proto3 optional and in no oneof",
  },
  {
    name: "a oneof index the message does not declare",
    mutate: (file) => {
      fieldAt(file).oneofIndex = 2;
    },
    detail: "the field p.M.a is in oneof number 2, which p.M does not declare",
  },
  {
    name: "a oneof with no fields",
    mutate: (file) => {
      messageAt(file).oneofDecl.push(create(OneofDescriptorProtoSchema, { name: "o" }));
    },
    detail: "the oneof p.M.o has no fields",
  },
  {
    name: "a oneof that mixes proto3 optional fields with other fields",
    mutate: (file) => {
      oneofWithA(file);
      messageAt(file).field.push(field({ name: "b", number: 2, type: T.STRING, oneofIndex: 0, proto3Optional: true }));
    },
    detail: "the oneof p.M.o mixes proto3 optional fields with other fields",
  },
  {
    name: "a oneof with two proto3 optional fields",
    mutate: (file) => {
      oneofWithA(file).proto3Optional = true;
      messageAt(file).field.push(field({ name: "b", number: 2, type: T.STRING, oneofIndex: 0, proto3Optional: true }));
    },
    detail: "the oneof p.M.o holds proto3 optional fields, and only a proto3 oneof with one such field is valid",
  },
  {
    name: "a proto3 optional field in a proto2 file",
    source: 'syntax = "proto2"; package p; message M { optional string a = 1; }',
    mutate: (file) => {
      oneofWithA(file, "_a").proto3Optional = true;
    },
    detail: "the oneof p.M._a holds proto3 optional fields, and only a proto3 oneof with one such field is valid",
  },
  {
    name: "a oneof name that is not an identifier",
    mutate: (file) => {
      oneofWithA(file, "1o");
    },
    detail: `a oneof of p.M is named "1o"${NOT_IDENTIFIER}`,
  },
  {
    name: "a repeated field in a oneof",
    mutate: (file) => {
      oneofWithA(file).label = L.REPEATED;
    },
    detail: "the field p.M.a is in a oneof and is not optional",
  },
  {
    name: "a field number of 0",
    mutate: (file) => {
      fieldAt(file).number = 0;
    },
    detail: "the field p.M.a has the number 0, and a field number runs from 1 to 536,870,911",
  },
  {
    name: "a field name that is not an identifier",
    mutate: (file) => {
      fieldAt(file).name = "a-b";
    },
    detail: `a field of p.M is named "a-b"${NOT_IDENTIFIER}`,
  },
  {
    name: "a required field in a proto3 file",
    mutate: (file) => {
      fieldAt(file).label = L.REQUIRED;
    },
    detail: "the field p.M.a is required, which proto3 does not allow",
  },
  {
    name: "an unknown type number",
    mutate: (file) => {
      fieldAt(file).type = typeNumber(99);
    },
    detail: "the field p.M.a has the unknown type number 99",
  },
  {
    name: "a message field with no type name",
    mutate: (file) => {
      fieldAt(file).type = T.MESSAGE;
    },
    detail: "the field p.M.a names no type",
  },
  {
    name: "a field type that is not a full name",
    mutate: (file) => {
      fieldAt(file).type = T.MESSAGE;
      fieldAt(file).typeName = "M";
    },
    detail: 'the field p.M.a is "M", which is not a full type name',
  },
  {
    name: "a message field that names an enum",
    mutate: (file) => {
      fieldAt(file).type = T.MESSAGE;
      fieldAt(file).typeName = ".p.E";
    },
    detail: "the field p.M.a is .p.E, which is not a message that a.proto or its imports define",
  },
  {
    name: "an enum field that names a message",
    mutate: (file) => {
      fieldAt(file).type = T.ENUM;
      fieldAt(file).typeName = ".p.M";
    },
    detail: "the field p.M.a is .p.M, which is not an enum that a.proto or its imports define",
  },
  {
    name: "a field with no type that names a service",
    mutate: (file) => {
      clearField(fieldAt(file), FieldDescriptorProtoSchema.field.type);
      fieldAt(file).typeName = ".p.S";
    },
    detail: "the field p.M.a is .p.S, which is not a message or an enum that a.proto or its imports define",
  },
  {
    name: "a field type from a file a.proto does not import",
    others: { "b.proto": 'syntax = "proto3"; package q; message Other {}' },
    mutate: (file) => {
      fieldAt(file).type = T.MESSAGE;
      fieldAt(file).typeName = ".q.Other";
    },
    detail: "the field p.M.a is .q.Other, which is not a message that a.proto or its imports define",
  },
  {
    name: "a map field whose entry is missing",
    source: 'syntax = "proto3"; package p; message M { map<string, string> tags = 1; }',
    mutate: (file) => {
      messageAt(file).nestedType = [];
    },
    detail: "the field p.M.tags is .p.M.TagsEntry, which is not a message that a.proto or its imports define",
  },
  {
    name: "a map value type nothing defines",
    source: 'syntax = "proto3"; package p; message M { map<string, string> tags = 1; }',
    mutate: (file) => {
      const value = at(at(messageAt(file).nestedType, 0).field, 1);
      value.type = T.MESSAGE;
      value.typeName = ".p.Nope";
    },
    detail: "the value of the field p.M.tags is .p.Nope, which is not a message that a.proto or its imports define",
  },
  {
    name: "an enum with no values",
    mutate: (file) => {
      at(file.enumType, 0).value = [];
    },
    detail: "the enum p.E has no values",
  },
  {
    name: "an enum name that is not an identifier",
    mutate: (file) => {
      at(file.enumType, 0).name = "1E";
    },
    detail: `an enum is named "1E"${NOT_IDENTIFIER}`,
  },
  {
    name: "an enum value name that is not an identifier",
    mutate: (file) => {
      at(at(file.enumType, 0).value, 0).name = "1X";
    },
    detail: `a value of p.E is named "1X"${NOT_IDENTIFIER}`,
  },
  {
    name: "an enum value named option",
    mutate: (file) => {
      at(at(file.enumType, 0).value, 0).name = "option";
    },
    detail: "the enum value p.E.option is named option, which protobufjs reads as a keyword",
  },
  {
    name: "an enum value named reserved",
    mutate: (file) => {
      at(at(file.enumType, 0).value, 0).name = "reserved";
    },
    detail: "the enum value p.E.reserved is named reserved, which protobufjs reads as a keyword",
  },
  {
    name: "an extension with no extendee",
    mutate: (file) => {
      file.extension.push(field({ name: "x", number: 100, type: T.INT32 }));
    },
    detail: "the extension p.x names no message to extend",
  },
  {
    name: "an extension in a oneof",
    mutate: (file) => {
      file.extension.push(field({ name: "x", number: 100, type: T.INT32, extendee: ".p.M", oneofIndex: 0 }));
    },
    detail: "the extension p.x is in a oneof",
  },
  {
    name: "an extension of an enum",
    mutate: (file) => {
      file.extension.push(field({ name: "x", number: 100, type: T.INT32, extendee: ".p.E" }));
    },
    detail: "the message the extension p.x extends is .p.E, which is not a message that a.proto or its imports define",
  },
  {
    name: "a proto3 optional extension",
    mutate: (file) => {
      file.extension.push(field({ name: "x", number: 100, type: T.INT32, extendee: ".p.M", proto3Optional: true }));
    },
    detail: "the extension p.x is a proto3 optional extension, which import does not read",
  },
  {
    name: "an extension name that is not an identifier in a file with no package",
    source: 'syntax = "proto2"; message M { extensions 100 to 200; } extend M { optional int32 x = 100; }',
    mutate: (file) => {
      at(file.extension, 0).name = "x-y";
    },
    detail: `a field of a.proto is named "x-y"${NOT_IDENTIFIER}`,
  },
];

describe("printProto refusals", () => {
  it.each(refusals)("refuses $name", ({ source = BASE, others = {}, mutate, detail }) => {
    const error = printRefusal(mutated(filesOf(source, others), mutate));
    expect(error.code).toBe("reflection");
    expect(error.file).toBe(A);
    expect(error.message).toBe(refusalText(detail));
  });

  it("refuses a group field as unsupported, and says to change it to a message field", () => {
    const error = printRefusal(
      mutated(filesOf(BASE), (file) => {
        fieldAt(file).type = T.GROUP;
      }),
    );
    expect(error.code).toBe("unsupported");
    expect(error.file).toBe(A);
    expect(error.message).toBe(
      "the field p.M.a in a.proto is a group, which import does not read. Change the group to a message field on the server, then import again.",
    );
  });
});

describe("printProto notes", () => {
  it("leaves out each proto2 default the text cannot carry", () => {
    const source = `syntax = "proto2";
package p;
message M {
  optional string s = 1;
  repeated int32 r = 2;
  optional M n = 3;
  optional E e = 4;
  optional bool b = 5;
  optional bytes y = 6;
  optional int32 d = 7;
}
enum E { E_ZERO = 0; }
`;
    const files = filesOf(source);
    const defaults = ["a\\b", "1", "x", "true", "yes", String.raw`\001`, "0x10"];
    const changed = mutated(files, (file) => {
      defaults.forEach((value, index) => {
        fieldAt(file, index).defaultValue = value;
      });
    });
    const printed = expectReadsBackAs(changed, fileNamed(files));
    expect(printed.notes).toStrictEqual([
      leftOut("the default value of the field p.M.s, because it holds a backslash or a control character"),
      leftOut("the default value of the field p.M.r, because a repeated field has no default value"),
      leftOut("the default value of the field p.M.n, because a message field has no default value"),
      leftOut("the default value of the field p.M.e, because protobufjs reads true as something other than an enum value name"),
      leftOut("the default value of the field p.M.b, because yes is not true or false"),
      leftOut("the default value of the field p.M.y, because it holds escaped bytes"),
      leftOut("the default value of the field p.M.d, because protobufjs does not read 0x10 as a number"),
    ]);
  });

  it("leaves out a default in a proto3 file", () => {
    const files = filesOf(BASE);
    const changed = mutated(files, (file) => {
      fieldAt(file).defaultValue = "x";
    });
    const printed = expectReadsBackAs(changed, fileNamed(files));
    expect(printed.notes).toStrictEqual([leftOut("the default value of the field p.M.a, because proto3 has no default values")]);
  });

  it("leaves out an extension's JSON name", () => {
    const source = `syntax = "proto3";
package p;
import "google/protobuf/descriptor.proto";
extend google.protobuf.MessageOptions { int32 x_y = 50000; }
`;
    const files = filesOf(source);
    const changed = mutated(files, (file) => {
      at(file.extension, 0).jsonName = "custom";
    });
    const printed = expectReadsBackAs(changed, fileNamed(files));
    expect(printed.notes).toStrictEqual([
      leftOut("the JSON name custom of the extension p.x_y, because an extension takes its JSON name from its field name"),
    ]);
  });

  it("leaves out a JSON name that holds a control character", () => {
    const files = filesOf(BASE);
    const changed = mutated(files, (file) => {
      fieldAt(file).jsonName = `a${String.fromCharCode(1)}`;
    });
    const printed = expectReadsBackAs(changed, fileNamed(files));
    expect(printed.notes).toStrictEqual([leftOut("the JSON name of the field p.M.a, because it holds a control character")]);
  });

  it("leaves out the options on an extension range", () => {
    const files = filesOf('syntax = "proto2"; package p; message M { extensions 100 to 200; }');
    const changed = mutated(files, (file) => {
      at(messageAt(file).extensionRange, 0).options = create(ExtensionRangeOptionsSchema);
    });
    const printed = expectReadsBackAs(changed, fileNamed(files));
    expect(printed.text).toContain("  extensions 100 to 200;");
    expect(printed.notes).toStrictEqual([
      leftOut("the options on the extension range 100 to 200 of p.M, because protobufjs does not read them"),
    ]);
  });

  it("leaves out message ranges and reserved names the text cannot carry", () => {
    const changed = mutated(filesOf('syntax = "proto2"; package p; message M { optional int32 a = 1; }'), (file) => {
      const message = messageAt(file);
      message.extensionRange = [create(DescriptorProto_ExtensionRangeSchema, { start: 0, end: 5 })];
      message.reservedRange = [
        create(DescriptorProto_ReservedRangeSchema, { start: 5, end: 5 }),
        create(DescriptorProto_ReservedRangeSchema, { start: 1, end: 536_870_913 }),
      ];
      message.reservedName = ["not valid", "ok"];
    });
    const expected = fileNamed(filesOf('syntax = "proto2"; package p; message M { optional int32 a = 1; reserved "ok"; }'));
    const printed = expectReadsBackAs(changed, expected);
    expect(printed.text).not.toContain("extensions");
    expect(printed.notes).toStrictEqual([
      leftOut("an extension range of p.M, 0 to 4, because it falls outside the field numbers 1 to 536,870,911"),
      leftOut("a reserved range of p.M, because it holds no number"),
      leftOut("a reserved range of p.M, 1 to 536870912, because it falls outside the field numbers 1 to 536,870,911"),
      leftOut('the reserved name "not valid" of p.M, because it is not a valid .proto identifier'),
    ]);
  });

  it("leaves out negative and empty enum reserved ranges and writes a one-number range", () => {
    const changed = mutated(filesOf('syntax = "proto2"; package p; enum E { E_ZERO = 0; }'), (file) => {
      at(file.enumType, 0).reservedRange = [
        create(EnumDescriptorProto_EnumReservedRangeSchema, { start: -5, end: -1 }),
        create(EnumDescriptorProto_EnumReservedRangeSchema, { start: 4, end: 3 }),
        create(EnumDescriptorProto_EnumReservedRangeSchema, { start: 7, end: 7 }),
      ];
    });
    const expected = fileNamed(filesOf('syntax = "proto2"; package p; enum E { E_ZERO = 0; reserved 7; }'));
    const printed = expectReadsBackAs(changed, expected);
    expect(printed.text).toContain("  reserved 7;");
    expect(printed.notes).toStrictEqual([
      leftOut("the reserved range -5 to -1 of p.E, because protobufjs does not read a negative reserved number"),
      leftOut("a reserved range of p.E, because it holds no number"),
    ]);
  });

  it("leaves out an enum option whose number the enum does not declare", () => {
    const files = filesOf(BASE);
    const changed = mutated(files, (file) => {
      methodAt(file).options = create(MethodOptionsSchema, { idempotencyLevel: idempotency(7) });
    });
    const printed = expectReadsBackAs(changed, fileNamed(files));
    expect(printed.text).toContain("  rpc Get(M) returns (M);");
    expect(printed.notes).toStrictEqual([
      leftOut(
        "the option idempotency_level on the method p.S.Get, because 7 is not a value of google.protobuf.MethodOptions.IdempotencyLevel",
      ),
    ]);
  });

  it("leaves out a list option", () => {
    const files = filesOf(BASE);
    const changed = mutated(files, (file) => {
      messageAt(file).options = create(MessageOptionsSchema, { uninterpretedOption: [{ identifierValue: "x" }] });
    });
    const printed = expectReadsBackAs(changed, fileNamed(files));
    expect(printed.notes).toStrictEqual([
      leftOut("the option uninterpreted_option on the message p.M, because the text cannot carry a list, a map, or a message value"),
    ]);
  });

  it("leaves out a string option that holds a control character", () => {
    const files = filesOf(BASE);
    const changed = mutated(files, (file) => {
      file.options = create(FileOptionsSchema, { goPackage: `a${String.fromCharCode(1)}` });
    });
    const printed = expectReadsBackAs(changed, fileNamed(files));
    expect(printed.notes).toStrictEqual([
      leftOut("the option go_package on the file, because its value holds a control character"),
    ]);
  });

  it("notes custom options once for the file", () => {
    const custom = new BinaryWriter().tag(50000, WireType.Varint).int32(1).finish();
    const files = filesOf(BASE);
    const changed = mutated(files, (file) => {
      messageAt(file).options = fromBinary(MessageOptionsSchema, custom);
      methodAt(file).options = fromBinary(MethodOptionsSchema, custom);
    });
    const symbols = new Symbols();
    for (const file of changed) symbols.register(file);
    const notes = new Notes();
    printProto(fileNamed(changed), symbols, new Visibility(changed).of(A), notes);
    expect(notes.list).toStrictEqual([
      {
        tool: undefined,
        message:
          "Server reflection gave a.proto custom options. The .proto text import writes leaves them out, because the gateway reads none of them.",
      },
    ]);
    expectReadsBackAs(changed, fileNamed(files));
  });

  it("gives every note no tool", () => {
    const files = mutated(filesOf(BASE), (file) => {
      fieldAt(file).defaultValue = "x";
    });
    const symbols = new Symbols();
    for (const file of files) symbols.register(file);
    const notes = new Notes();
    printProto(fileNamed(files), symbols, new Visibility(files).of(A), notes);
    expect(notes.list.map((note) => note.tool)).toStrictEqual([undefined]);
  });
});
