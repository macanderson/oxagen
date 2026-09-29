// descriptors.test.ts: the FileDescriptorProto buildSet makes from .proto
// text, how set.ts and symbols.ts resolve its type names, and the tool keys
// and notes importGrpc gives its methods.
//
// Each expected value follows from reading descriptors.ts, set.ts,
// symbols.ts, names.ts, and tools.ts against protobufjs 7.6.3 and
// @bufbuild/protobuf 2.12.0. Where protoc writes or says something else, a
// comment names the difference.
import { create, equals, isFieldSet, toJson, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import {
  DescriptorProtoSchema,
  EnumDescriptorProtoSchema,
  FieldDescriptorProtoSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldOptionsSchema,
  FileDescriptorProtoSchema,
  FileOptionsSchema,
  type DescriptorProto,
  type FileDescriptorProto,
} from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { TOOL_KEY_MAX } from "../contract/primitives";
import { Notes } from "../graphql/notes";
import type { ImportedFile, ImportNote } from "../model/import-result";
import { jsonNameOf, mapEntryNameOf } from "./descriptors";
import { GrpcImportError, type GrpcImportErrorCode } from "./errors";
import { importGrpc } from "./index";
import { toolKeyFor } from "./names";
import { buildSet } from "./set";

const A = "a.proto";
const T = FieldDescriptorProto_Type;
const L = FieldDescriptorProto_Label;
const K = TOOL_KEY_MAX;

/** One file's text, which is a.proto, or several files by their names under proto/. */
type Sources = string | Readonly<Record<string, string>>;

interface Built {
  files: FileDescriptorProto[];
  notes: ImportNote[];
}

/** The lines as one file's text. */
function proto(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

/** A proto3 file in package p. */
function p3(...lines: string[]): string {
  return proto('syntax = "proto3";', "package p;", ...lines);
}

/** A proto2 file in package p. */
function p2(...lines: string[]): string {
  return proto('syntax = "proto2";', "package p;", ...lines);
}

/** The sources as import input, each file under proto/. */
function inputOf(sources: Sources): ImportedFile[] {
  const named: Readonly<Record<string, string>> = typeof sources === "string" ? { [A]: sources } : sources;
  return Object.entries(named).map(([name, text]) => ({ path: `proto/${name}`, text }));
}

function build(sources: Sources): Built {
  const notes = new Notes();
  const { files } = buildSet(inputOf(sources), notes);
  return { files, notes: notes.list };
}

function fileNamed(files: readonly FileDescriptorProto[], name = A): FileDescriptorProto {
  const file = files.find((each) => each.name === name);
  if (file === undefined) throw new Error(`No file is named ${name}.`);
  return file;
}

function fileOf(sources: Sources, name = A): FileDescriptorProto {
  return fileNamed(build(sources).files, name);
}

function messageNamed(file: FileDescriptorProto, name: string): DescriptorProto {
  const message = file.messageType.find((each) => each.name === name);
  if (message === undefined) throw new Error(`${file.name} declares no message ${name}.`);
  return message;
}

/** The top-level message named `name` in a.proto. */
function messageOf(sources: Sources, name = "M"): DescriptorProto {
  return messageNamed(fileOf(sources), name);
}

/** The item at the index, or a thrown error that names the index. */
function at<V>(list: readonly V[], index: number): V {
  const item = list[index];
  if (item === undefined) throw new Error(`The list has no item at index ${index}.`);
  return item;
}

function defined<V>(value: V | undefined, what: string): V {
  if (value === undefined) throw new Error(`${what} is not set.`);
  return value;
}

/** Checks two messages are equal. toJson gives a readable diff, and equals also compares what JSON does not show. */
function expectSame<Desc extends DescMessage>(schema: Desc, actual: MessageShape<Desc>, expected: MessageShape<Desc>): void {
  expect(toJson(schema, actual)).toStrictEqual(toJson(schema, expected));
  expect(equals(schema, actual, expected)).toBe(true);
}

/** The refusal buildSet throws for the sources. */
function refusal(sources: Sources): GrpcImportError {
  try {
    build(sources);
  } catch (error) {
    if (error instanceof GrpcImportError) return error;
    throw error;
  }
  throw new Error("buildSet built the files.");
}

/** Checks the refusal's code, the file it names, and its whole message. */
function expectRefusal(sources: Sources, code: GrpcImportErrorCode, file: string, message: string): void {
  const error = refusal(sources);
  expect(error.code).toBe(code);
  expect(error.file).toBe(file);
  expect(error.message).toBe(message);
}

/** Each field's name with its default_value, or undefined when the descriptor leaves it unset. */
function defaultsOf(message: DescriptorProto): [string, string | undefined][] {
  return message.field.map((field): [string, string | undefined] => [
    field.name,
    isFieldSet(field, FieldDescriptorProtoSchema.field.defaultValue) ? field.defaultValue : undefined,
  ]);
}

describe("jsonNameOf", () => {
  const names: [string, string][] = [
    ["foo_bar_baz", "fooBarBaz"],
    ["foo", "foo"],
    ["_foo", "Foo"],
    ["foo_", "foo"],
    ["foo__bar", "fooBar"],
    ["foo_1", "foo1"],
    ["fooBar", "fooBar"],
  ];

  it.each(names)("writes %s as %s", (name, json) => {
    expect(jsonNameOf(name)).toBe(json);
  });
});

describe("mapEntryNameOf", () => {
  const names: [string, string][] = [
    ["tags", "TagsEntry"],
    ["foo_bar", "FooBarEntry"],
    ["_x", "XEntry"],
    ["fooBar", "FooBarEntry"],
    ["foo_1", "Foo1Entry"],
  ];

  it.each(names)("names the entry of %s %s", (field, entry) => {
    expect(mapEntryNameOf(field)).toBe(entry);
  });
});

describe("buildFile header", () => {
  it("lists each import in order with the indexes of the public and weak ones", () => {
    const empty = proto('syntax = "proto3";');
    const file = fileOf({
      "a.proto": proto('syntax = "proto3";', 'import public "b.proto";', 'import weak "c.proto";', 'import "d.proto";'),
      "b.proto": empty,
      "c.proto": empty,
      "d.proto": empty,
    });
    expectSame(
      FileDescriptorProtoSchema,
      file,
      create(FileDescriptorProtoSchema, {
        name: A,
        dependency: ["b.proto", "c.proto", "d.proto"],
        publicDependency: [0],
        weakDependency: [1],
        syntax: "proto3",
      }),
    );
  });

  it("reads an import path written as two adjacent string literals", () => {
    const file = fileOf({
      "a.proto": proto('syntax = "proto3";', `import "sub/" 'b.proto';`),
      "sub/b.proto": proto('syntax = "proto3";'),
    });
    expect(file.dependency).toStrictEqual(["sub/b.proto"]);
  });

  const proto2Files: [string, string][] = [
    ["no syntax statement", proto("package p;", "message M {}")],
    ["syntax proto2", p2("message M {}")],
  ];

  it.each(proto2Files)("leaves syntax unset for a file with %s, as protoc does", (_label, text) => {
    expect(isFieldSet(fileOf(text), FileDescriptorProtoSchema.field.syntax)).toBe(false);
  });

  it("merges the file options set before and after the package statement", () => {
    const file = fileOf(proto('syntax = "proto3";', 'option java_package = "com.x";', "package p;", 'option go_package = "x/p";'));
    expectSame(
      FileOptionsSchema,
      defined(file.options, "a.proto's options"),
      create(FileOptionsSchema, { javaPackage: "com.x", goPackage: "x/p" }),
    );
  });
});

describe("buildFile messages", () => {
  it("writes a proto3 message's fields, nested types, map entry, and oneofs in order", () => {
    const { files, notes } = build(
      p3(
        "message M {",
        "  optional string maybe = 1;",
        "  oneof choice {",
        "    string a = 2;",
        "    int32 b = 3;",
        "  }",
        "  map<string, int32> tags = 4;",
        "  message Inner {}",
        "  enum Kind { KIND_UNSPECIFIED = 0; }",
        "}",
      ),
    );
    expectSame(
      DescriptorProtoSchema,
      messageNamed(fileNamed(files), "M"),
      create(DescriptorProtoSchema, {
        name: "M",
        field: [
          { name: "maybe", number: 1, label: L.OPTIONAL, type: T.STRING, jsonName: "maybe", oneofIndex: 1, proto3Optional: true },
          { name: "a", number: 2, label: L.OPTIONAL, type: T.STRING, jsonName: "a", oneofIndex: 0 },
          { name: "b", number: 3, label: L.OPTIONAL, type: T.INT32, jsonName: "b", oneofIndex: 0 },
          { name: "tags", number: 4, label: L.REPEATED, type: T.MESSAGE, typeName: ".p.M.TagsEntry", jsonName: "tags" },
        ],
        // protoc adds TagsEntry where the map field is declared, before Inner.
        nestedType: [
          { name: "Inner" },
          {
            name: "TagsEntry",
            field: [
              { name: "key", number: 1, label: L.OPTIONAL, type: T.STRING, jsonName: "key" },
              { name: "value", number: 2, label: L.OPTIONAL, type: T.INT32, jsonName: "value" },
            ],
            options: { mapEntry: true },
          },
        ],
        enumType: [{ name: "Kind", value: [{ name: "KIND_UNSPECIFIED", number: 0 }] }],
        // The real oneof comes first and the one protobufjs made for `optional` last, as protoc orders them.
        oneofDecl: [{ name: "choice" }, { name: "_maybe" }],
      }),
    );
    expect(notes).toStrictEqual([]);
  });

  it("writes a required field and ranges that end one past the last number", () => {
    expectSame(
      DescriptorProtoSchema,
      messageOf(
        p2(
          "message M {",
          "  required int32 id = 1;",
          "  extensions 100 to 199;",
          "  extensions 500;",
          "  extensions 1000 to max;",
          "  reserved 10 to 12, 15;",
          '  reserved "old";',
          "}",
        ),
      ),
      create(DescriptorProtoSchema, {
        name: "M",
        field: [{ name: "id", number: 1, label: L.REQUIRED, type: T.INT32, jsonName: "id" }],
        extensionRange: [
          { start: 100, end: 200 },
          { start: 500, end: 501 },
          { start: 1000, end: 536_870_912 },
        ],
        reservedRange: [
          { start: 10, end: 13 },
          { start: 15, end: 16 },
        ],
        reservedName: ["old"],
      }),
    );
  });

  it("writes an extension declared inside a message under that message", () => {
    const message = messageOf(
      p2(
        'import "google/protobuf/descriptor.proto";',
        "message M {",
        "  extend google.protobuf.MessageOptions {",
        "    optional int32 opt = 50001;",
        "  }",
        "}",
      ),
    );
    expectSame(
      DescriptorProtoSchema,
      message,
      create(DescriptorProtoSchema, {
        name: "M",
        extension: [
          {
            name: "opt",
            number: 50_001,
            label: L.OPTIONAL,
            type: T.INT32,
            jsonName: "opt",
            extendee: ".google.protobuf.MessageOptions",
          },
        ],
      }),
    );
  });

  it("keeps a json_name that tells two JSON names apart and leaves it out of the field options", () => {
    const message = messageOf(p3("message M {", "  string foo_bar = 1;", '  string fooBar = 2 [json_name = "other"];', "}"));
    expect(message.field.map((field) => field.jsonName)).toStrictEqual(["fooBar", "other"]);
    expect(at(message.field, 1).options).toBeUndefined();
  });
});

describe("buildFile enums", () => {
  it("writes values, aliases, value options, and reserved ranges", () => {
    const file = fileOf(
      p3(
        "enum Mode {",
        "  option allow_alias = true;",
        "  MODE_UNSPECIFIED = 0;",
        "  MODE_ON = 1 [deprecated = true];",
        "  MODE_ENABLED = 1;",
        "  reserved 2, 5 to max;",
        '  reserved "MODE_OLD";',
        "}",
      ),
    );
    expectSame(
      EnumDescriptorProtoSchema,
      at(file.enumType, 0),
      create(EnumDescriptorProtoSchema, {
        name: "Mode",
        value: [
          { name: "MODE_UNSPECIFIED", number: 0 },
          { name: "MODE_ON", number: 1, options: { deprecated: true } },
          { name: "MODE_ENABLED", number: 1 },
        ],
        options: { allowAlias: true },
        // An enum's reserved ranges keep their inclusive end, and max is 2^31 - 1.
        reservedRange: [
          { start: 2, end: 2 },
          { start: 5, end: 2_147_483_647 },
        ],
        reservedName: ["MODE_OLD"],
      }),
    );
  });

  it("lets a proto2 enum start at a value other than 0", () => {
    const enumType = at(fileOf(p2("enum E { E_ONE = 1; }")).enumType, 0);
    expect(enumType.value.map((value) => [value.name, value.number])).toStrictEqual([["E_ONE", 1]]);
  });
});

describe("buildFile default values", () => {
  it("writes each proto2 default as protoc does and leaves out the ones protobufjs cannot carry", () => {
    const { files, notes } = build(
      p2(
        "enum Kind { KIND_A = 0; KIND_B = 1; }",
        "message M {",
        '  optional string escaped = 1 [default = "a\\nb"];',
        "  optional int64 big = 2 [default = 9007199254740993];",
        `  optional bytes quote = 3 [default = "a'b"];`,
        '  optional bytes accent = 4 [default = "é"];',
        "  optional double high = 5 [default = inf];",
        "  optional double low = 6 [default = -inf];",
        "  optional float odd = 7 [default = nan];",
        "  optional bool flag = 8 [default = false];",
        "  optional sint32 negative = 9 [default = -7];",
        "  optional double half = 10 [default = 2.5];",
        '  optional string hello = 11 [default = "hi"];',
        "  optional Kind kind = 12 [default = KIND_B];",
        `  optional string said = 13 [default = 'say "x"'];`,
        `  optional bytes quoted = 14 [default = 'q"q'];`,
        '  optional bytes lines = 15 [default = "x\\ty"];',
        "  optional int32 plain = 16;",
        "}",
      ),
    );
    expect(defaultsOf(messageNamed(fileNamed(files), "M"))).toStrictEqual([
      ["escaped", undefined],
      ["big", undefined],
      ["quote", "a\\'b"],
      // A bytes default is C-escaped byte by byte: é is the two UTF-8 bytes 0xC3 0xA9.
      ["accent", "\\303\\251"],
      ["high", "inf"],
      ["low", "-inf"],
      ["odd", "nan"],
      ["flag", "false"],
      ["negative", "-7"],
      ["half", "2.5"],
      ["hello", "hi"],
      ["kind", "KIND_B"],
      ["said", 'say "x"'],
      ["quoted", 'q\\"q'],
      ["lines", undefined],
      ["plain", undefined],
    ]);

    const dropped = (field: string, why: string): ImportNote => ({
      tool: undefined,
      message: `p.M.${field} has a default value ${why}, so the descriptor set leaves it out. A call is unchanged: the gateway sends and returns only the fields a message sets.`,
    });
    const escape = "written with an escape, which protobufjs does not read exactly";
    expect(notes).toStrictEqual([
      dropped("escaped", escape),
      dropped("big", "past 2^53, which protobufjs rounds"),
      dropped("lines", escape),
    ]);
  });
});

describe("buildFile options", () => {
  it("leaves custom options out of the descriptors and notes them once for the whole set", () => {
    const { files, notes } = build(
      p3(
        'option (tag) = "x";',
        "message M {",
        "  option (my.ext).b = 2;",
        "  string a = 1 [(my.ext) = 1, deprecated = true];",
        "}",
      ),
    );
    const file = fileNamed(files);
    expect(file.options).toBeUndefined();
    const message = messageNamed(file, "M");
    expect(message.options).toBeUndefined();
    expectSame(
      FieldOptionsSchema,
      defined(at(message.field, 0).options, "The field's options"),
      create(FieldOptionsSchema, { deprecated: true }),
    );
    expect(notes).toStrictEqual([
      {
        tool: undefined,
        message:
          "The files set the custom options (my.ext), (tag). The descriptor set leaves them out, because the gateway reads none of them.",
      },
    ]);
  });

  const unknownOptions: [string, string, string, string, string][] = [
    ["the file", p3('option java_pakage = "x";'), A, "FileOptions", "java_pakage"],
    ["a message", p3("message M { option not_an_option = true; }"), "p.M", "MessageOptions", "not_an_option"],
    ["a field", p3("message M { string a = 1 [not_an_option = true]; }"), "p.M.a", "FieldOptions", "not_an_option"],
    [
      "a oneof",
      p3("message M { oneof o { option not_an_option = true; string a = 1; } }"),
      "p.M.o",
      "OneofOptions",
      "not_an_option",
    ],
    ["an enum", p3("enum E { option not_an_option = true; E_ZERO = 0; }"), "p.E", "EnumOptions", "not_an_option"],
    ["an enum value", p3("enum E { E_ZERO = 0 [not_an_option = true]; }"), "p.E.E_ZERO", "EnumValueOptions", "not_an_option"],
    ["a service", p3("service S { option not_an_option = true; }"), "p.S", "ServiceOptions", "not_an_option"],
    [
      "a method",
      p3("message M {}", "service S { rpc Get(M) returns (M) { option not_an_option = true; } }"),
      "p.S.Get",
      "MethodOptions",
      "not_an_option",
    ],
  ];

  it.each(unknownOptions)("refuses an option protobuf does not define on %s", (_label, text, where, schema, key) => {
    const error = refusal(text);
    expect(error.code).toBe("unsupported");
    expect(error.file).toBe(A);
    expect(error.message).toContain(`a.proto sets an option on ${where} that google.protobuf.${schema} does not define: `);
    expect(error.message).toContain(`key "${key}" is unknown`);
    expect(error.message.endsWith(". Correct or remove the option.")).toBe(true);
  });

  it("refuses a built-in option set to a value of the wrong type, in the same words", () => {
    // A wart: the option exists, and the refusal still says MessageOptions does not define it.
    const error = refusal(p3('message M { option deprecated = "yes"; }'));
    expect(error.code).toBe("unsupported");
    expect(error.file).toBe(A);
    expect(error.message).toContain("a.proto sets an option on p.M that google.protobuf.MessageOptions does not define: ");
    expect(error.message.endsWith(". Correct or remove the option.")).toBe(true);
  });
});

describe("buildFile refusals", () => {
  it("refuses a group", () => {
    expectRefusal(
      p2("message M {", "  optional group G = 1 {", "    optional int32 a = 2;", "  }", "}"),
      "unsupported",
      A,
      "a.proto declares the group p.M.G. Import does not read groups, so declare a message and a message field in its place.",
    );
  });

  const clashes: [string, string, string][] = [
    [
      "two field names that give one JSON name",
      "string foo_bar = 1; string fooBar = 2;",
      "a.proto gives the fields foo_bar and fooBar of p.M the same JSON name, fooBar. The message's JSON form cannot hold both, so rename one or set json_name.",
    ],
    [
      "a json_name that repeats another field's JSON name",
      'string a = 1; string b = 2 [json_name = "a"];',
      "a.proto gives the fields a and b of p.M the same JSON name, a. The message's JSON form cannot hold both, so rename one or set json_name.",
    ],
  ];

  it.each(clashes)("refuses %s", (_label, fields, message) => {
    expectRefusal(p3(`message M { ${fields} }`), "invalid", A, message);
  });

  it.each([0, 19_000, 19_999, 536_870_912])("refuses the field number %i", (number) => {
    expectRefusal(
      p3(`message M { string a = ${number}; }`),
      "invalid",
      A,
      `a.proto numbers the field p.M.a ${number}. A field number runs from 1 to 536,870,911 and skips 19,000 to 19,999, which protobuf reserves, so renumber it.`,
    );
  });

  it.each([1, 18_999, 20_000, 536_870_911])("accepts the field number %i", (number) => {
    expect(at(messageOf(p3(`message M { string a = ${number}; }`)).field, 0).number).toBe(number);
  });

  it("refuses a required extension in proto3", () => {
    // protobufjs reads `required` inside an extend block in any syntax, so descriptors.ts checks it.
    expectRefusal(
      p3("extend google.protobuf.MessageOptions { required int32 x = 50000; }"),
      "invalid",
      A,
      "a.proto marks p.x required. proto3 has no required fields, so remove the label.",
    );
  });

  it("refuses a default value in proto3", () => {
    expectRefusal(
      p3("message M { int32 a = 1 [default = 5]; }"),
      "invalid",
      A,
      "a.proto gives p.M.a a default value. proto3 has no default values, so remove it.",
    );
  });

  const firstValues: [string, string, string][] = [
    [
      "a top-level enum",
      "enum TaskState { RUNNING = 1; }",
      "a.proto starts the enum p.TaskState at RUNNING = 1. A proto3 enum's first value must be 0, so add a value such as TASK_STATE_UNSPECIFIED = 0 before it.",
    ],
    [
      // A wart: the suggestion does not split an acronym, so HTTPCode suggests HTTPCODE_UNSPECIFIED.
      "a nested enum whose name starts with an acronym",
      "message M { enum HTTPCode { OK = 200; } }",
      "a.proto starts the enum p.M.HTTPCode at OK = 200. A proto3 enum's first value must be 0, so add a value such as HTTPCODE_UNSPECIFIED = 0 before it.",
    ],
  ];

  it.each(firstValues)("refuses a proto3 enum that does not start at 0: %s", (_label, text, message) => {
    expectRefusal(p3(text), "invalid", A, message);
  });
});

describe("Symbols duplicate names", () => {
  const duplicates: [string, Sources, string, string][] = [
    [
      "a message two files define",
      { "a.proto": p3("message M {}"), "b.proto": p3("message M {}") },
      "b.proto",
      "b.proto defines p.M, which a.proto already defines. Rename one of them.",
    ],
    [
      "a map entry beside a nested message with its name",
      p3("message M {", "  map<string, int32> tags = 1;", "  message TagsEntry {}", "}"),
      A,
      "a.proto defines p.M.TagsEntry twice. Rename one of them.",
    ],
    [
      "a message named like an earlier file's package",
      { "a.proto": proto('syntax = "proto3";', "package p.v1;"), "b.proto": proto('syntax = "proto3";', "message p {}") },
      "b.proto",
      "b.proto defines p, which a.proto already defines. Rename one of them.",
    ],
    [
      "a package named like an earlier file's message",
      { "a.proto": proto('syntax = "proto3";', "message p {}"), "b.proto": proto('syntax = "proto3";', "package p.v1;") },
      "b.proto",
      "b.proto defines p, which a.proto already defines. Rename one of them.",
    ],
  ];

  it.each(duplicates)("refuses %s", (_label, sources, file, message) => {
    expectRefusal(sources, "duplicate", file, message);
  });
});

describe("type name resolution", () => {
  const other = proto('syntax = "proto3";', "package q;", "message Other {}");

  it("names the file to import when another file defines the type", () => {
    expectRefusal(
      { "a.proto": p3("message M { q.Other o = 1; }"), "b.proto": other },
      "unresolved",
      A,
      'In a.proto, the field p.M.o names q.Other, which b.proto defines, but a.proto does not import b.proto. Add import "b.proto"; to a.proto.',
    );
  });

  it("refuses a type no file defines", () => {
    expectRefusal(
      p3("message M { Nope n = 1; }"),
      "unresolved",
      A,
      "In a.proto, the field p.M.n names Nope, which none of its imports defines. Define Nope, or import the file that does.",
    );
  });

  const notTypes: [string, Sources, string][] = [
    [
      "an enum as a request type",
      p3("enum E { E_ZERO = 0; }", "message M {}", "service S { rpc Get(E) returns (M); }"),
      "In a.proto, the request type of p.S/Get names E, which is the enum p.E. It must name a message.",
    ],
    [
      "an enum as a response type",
      p3("enum E { E_ZERO = 0; }", "message M {}", "service S { rpc Get(M) returns (E); }"),
      "In a.proto, the response type of p.S/Get names E, which is the enum p.E. It must name a message.",
    ],
    [
      "a service as a field type",
      p3("message M { p.S s = 1; }", "service S {}"),
      "In a.proto, the field p.M.s names p.S, which is the service p.S. It must name a message or an enum.",
    ],
    [
      "a package as a field type",
      p3("message M { p x = 1; }"),
      "In a.proto, the field p.M.x names p, which is the package p. It must name a message or an enum.",
    ],
    [
      "an enum as an extendee",
      {
        "a.proto": p2('import "b.proto";', "extend E {", "  optional int32 x = 100;", "}"),
        "b.proto": p2("enum E { E_ZERO = 0; }"),
      },
      "In a.proto, the extension p.x names E, which is the enum p.E. It must name a message.",
    ],
  ];

  it.each(notTypes)("refuses %s", (_label, sources, message) => {
    expectRefusal(sources, "unresolved", A, message);
  });

  it("sees a type through a chain of public imports", () => {
    const message = messageOf({
      "a.proto": p3('import "b.proto";', "message M { d.D x = 1; }"),
      "b.proto": proto('syntax = "proto3";', 'import public "c.proto";'),
      "c.proto": proto('syntax = "proto3";', 'import public "d.proto";'),
      "d.proto": proto('syntax = "proto3";', "package d;", "message D {}"),
    });
    expect([at(message.field, 0).type, at(message.field, 0).typeName]).toStrictEqual([T.MESSAGE, ".d.D"]);
  });

  it("stops at a plain import in the chain and names the file to import", () => {
    expectRefusal(
      {
        "a.proto": p3('import "b.proto";', "message M { d.D x = 1; }"),
        "b.proto": proto('syntax = "proto3";', 'import "c.proto";'),
        "c.proto": proto('syntax = "proto3";', 'import public "d.proto";'),
        "d.proto": proto('syntax = "proto3";', "package d;", "message D {}"),
      },
      "unresolved",
      A,
      'In a.proto, the field p.M.x names d.D, which d.proto defines, but a.proto does not import d.proto. Add import "d.proto"; to a.proto.',
    );
  });

  it("finds a name in the innermost scope first, and a leading dot starts from the root", () => {
    const file = fileOf(
      p3(
        "message Inner {}",
        "message M {",
        "  message Inner {}",
        "  Inner near = 1;",
        "  .p.Inner far = 2;",
        "}",
        "message N { Inner i = 1; }",
      ),
    );
    expect(messageNamed(file, "M").field.map((field) => field.typeName)).toStrictEqual([".p.M.Inner", ".p.Inner"]);
    expect(messageNamed(file, "N").field.map((field) => field.typeName)).toStrictEqual([".p.Inner"]);
  });

  it("refuses a dotted name whose first part an inner scope holds, as protoc does", () => {
    // A wart: protoc says the name resolved to p.M.q.Other and suggests .q.Other. This says only that no import defines it.
    expectRefusal(
      { "a.proto": p3('import "b.proto";', "message M {", "  message q {}", "  q.Other o = 1;", "}"), "b.proto": other },
      "unresolved",
      A,
      "In a.proto, the field p.M.o names q.Other, which none of its imports defines. Define q.Other, or import the file that does.",
    );
  });

  it("resolves the same dotted name written with a leading dot", () => {
    const message = messageOf({
      "a.proto": p3('import "b.proto";', "message M {", "  message q {}", "  .q.Other o = 1;", "}"),
      "b.proto": other,
    });
    expect(at(message.field, 0).typeName).toBe(".q.Other");
  });

  it("passes over a package of the name and finds the message in an outer scope", () => {
    const message = messageOf({
      "a.proto": p3('import "b.proto";', 'import "c.proto";', "message M { Thing t = 1; }"),
      "b.proto": proto('syntax = "proto3";', "package p.Thing;"),
      "c.proto": proto('syntax = "proto3";', "message Thing {}"),
    });
    expect(at(message.field, 0).typeName).toBe(".Thing");
  });

  it("passes over a service of the name and refuses when no outer scope defines a type", () => {
    // A wart: a.proto defines S, as a service, and the refusal says none of its imports defines it. protoc says S is not a type.
    expectRefusal(
      p3("message M { S s = 1; }", "service S {}"),
      "unresolved",
      A,
      "In a.proto, the field p.M.s names S, which none of its imports defines. Define S, or import the file that does.",
    );
  });
});

describe("importGrpc tools and notes", () => {
  const services = p3(
    'import "google/protobuf/timestamp.proto";',
    'import "google/protobuf/wrappers.proto";',
    "message Req {}",
    "service A {",
    "  rpc Wrap(google.protobuf.StringValue) returns (Req);",
    "  rpc Old(Req) returns (Req) { option deprecated = true; }",
    "  rpc GetThing(Req) returns (Req);",
    "  rpc Stamp(Req) returns (google.protobuf.Timestamp);",
    "}",
    "service B {",
    "  rpc Wrap(Req) returns (Req);",
    "  rpc GetThing(Req) returns (Req);",
    "}",
  );

  it("makes no tool of a method whose request is not a JSON object, and frees its key", async () => {
    const result = await importGrpc({ files: inputOf(services) });
    expect(result.tools.map((tool) => [tool.name, tool.outputSchema !== undefined, tool.deprecated])).toStrictEqual([
      ["old", true, true],
      ["get_thing", true, undefined],
      ["stamp", false, undefined],
      ["wrap", true, undefined],
      ["get_thing_2", true, undefined],
    ]);
    expect(result.tools.map((tool) => tool.request)).toMatchObject([
      { method: "p.A/Old", request_type: "p.Req" },
      { method: "p.A/GetThing", request_type: "p.Req" },
      { method: "p.A/Stamp", request_type: "p.Req" },
      { method: "p.B/Wrap", request_type: "p.Req" },
      { method: "p.B/GetThing", request_type: "p.Req" },
    ]);
    expect(at(result.tools, 2).request).toStrictEqual({
      kind: "grpc",
      method: "p.A/Stamp",
      streaming: "unary",
      idempotency_level: "IDEMPOTENCY_UNKNOWN",
      request_type: "p.Req",
      response_type: "google.protobuf.Timestamp",
    });
    expect(result.listed).toStrictEqual([]);
  });

  it("notes the skipped method, the deprecated one, the missing outputSchema, and the renamed key", async () => {
    const { notes } = await importGrpc({ files: inputOf(services) });
    expect(notes).toStrictEqual([
      {
        tool: undefined,
        message:
          "p.A/Wrap takes google.protobuf.StringValue, whose JSON form is not an object, and a tool's arguments are one object. Import made no tool for it.",
      },
      { tool: "old", message: "p.A/Old is deprecated." },
      {
        tool: "stamp",
        message: "p.A/Stamp returns google.protobuf.Timestamp, whose JSON form is not an object, so the tool has no outputSchema.",
      },
      { tool: "get_thing_2", message: "Another method already takes get_thing, so p.B/GetThing takes get_thing_2." },
    ]);
  });

  it("makes no tools and says so when the files declare no service", async () => {
    const result = await importGrpc({ files: inputOf(p3("message M {}")) });
    expect(result.tools).toStrictEqual([]);
    expect(result.listed).toStrictEqual([]);
    expect(result.notes).toStrictEqual([
      {
        tool: undefined,
        message: "The files declare no service, so import made no tools. Import the files that declare the services.",
      },
    ]);
  });
});

describe("toolKeyFor", () => {
  const keys: [string, string][] = [
    ["GetHTTPRoute", "get_http_route"],
    ["_Get", "get"],
    ["Get__Thing", "get_thing"],
    ["2Fast", "method_2_fast"],
    ["_", "method"],
    ["GetV2Thing", "get_v2_thing"],
    ["ABC", "abc"],
    ["HTTPServer", "http_server"],
    ["_2x", "method_2x"],
  ];

  it.each(keys)("names the method %s %s", (method, key) => {
    const notes = new Notes();
    expect(toolKeyFor(`p.S/${method}`, method, new Set(), notes)).toBe(key);
    expect(notes.list).toStrictEqual([]);
  });

  it("gives a taken key _2, then _3, and notes each", () => {
    const notes = new Notes();
    const taken = new Set<string>();
    const keysTaken = ["p.A/Get", "p.B/Get", "p.C/Get"].map((path) => toolKeyFor(path, "Get", taken, notes));
    expect(keysTaken).toStrictEqual(["get", "get_2", "get_3"]);
    expect(notes.list).toStrictEqual([
      { tool: "get_2", message: "Another method already takes get, so p.B/Get takes get_2." },
      { tool: "get_3", message: "Another method already takes get, so p.C/Get takes get_3." },
    ]);
  });

  it("cuts a name past the key limit, and cuts it again to fit a suffix", () => {
    const notes = new Notes();
    const taken = new Set<string>();
    const long = "a".repeat(K + 9);
    const cut = "a".repeat(K);
    const second = `${"a".repeat(K - 2)}_2`;
    expect(toolKeyFor("p.A/Long", long, taken, notes)).toBe(cut);
    expect(toolKeyFor("p.B/Long", long, taken, notes)).toBe(second);
    expect(second).toHaveLength(K);
    expect(notes.list).toStrictEqual([
      { tool: cut, message: `p.A/Long suggests a name longer than ${K} characters, so it is cut to ${cut}.` },
      { tool: second, message: `p.B/Long suggests a name longer than ${K} characters, so it is cut to ${cut}.` },
      { tool: second, message: `Another method already takes ${cut}, so p.B/Long takes ${second}.` },
    ]);
  });

  it("drops the underscore a cut leaves at the end", () => {
    const notes = new Notes();
    const name = `${"a".repeat(K - 1)}${"_b".repeat(5)}`;
    const cut = "a".repeat(K - 1);
    expect(toolKeyFor("p.A/Cut", name, new Set(), notes)).toBe(cut);
    expect(notes.list).toStrictEqual([
      { tool: cut, message: `p.A/Cut suggests a name longer than ${K} characters, so it is cut to ${cut}.` },
    ]);
  });

  it("keeps a name of exactly the limit, and drops the underscore a suffix cut leaves", () => {
    const notes = new Notes();
    const taken = new Set<string>();
    const name = `${"a".repeat(K - 3)}_bb`;
    const second = `${"a".repeat(K - 3)}_2`;
    expect(name).toHaveLength(K);
    expect(toolKeyFor("p.A/Fit", name, taken, notes)).toBe(name);
    expect(toolKeyFor("p.B/Fit", name, taken, notes)).toBe(second);
    expect(notes.list).toStrictEqual([{ tool: second, message: `Another method already takes ${name}, so p.B/Fit takes ${second}.` }]);
  });
});
