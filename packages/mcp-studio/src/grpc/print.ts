// print.ts: one FileDescriptorProto from server reflection, written as .proto
// text.
//
// Oxagen keeps a server's definition as .proto files under proto/, and server
// reflection returns compiled FileDescriptorProtos. The printer writes each
// one as a proto2 or proto3 file that import reads back (source.ts,
// descriptors.ts) to the same descriptor. What the text cannot carry exactly
// is left out with a note, such as a custom option or a string default with
// an escape. What would read back as a different contract is refused, and the
// refusal asks for the server's .proto files.
//
// protobufjs sets three rules for the text:
// - A leading comment is the run of `//` lines directly above a declaration,
//   so each declaration sits on one line under its comment.
// - A string escape covers only \\, \0, \n, \r, and \t. A quote character is
//   written by splitting the string into adjacent literals, which protobufjs
//   joins.
// - The first word of a proto3 field line is its type, so a type name whose
//   first part is a keyword (RESERVED) is written longer.
import { create, equals, isFieldSet, ScalarType, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import {
  EnumOptionsSchema,
  EnumValueOptionsSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldDescriptorProtoSchema,
  FieldOptionsSchema,
  FileOptionsSchema,
  MessageOptionsSchema,
  MethodOptionsSchema,
  OneofOptionsSchema,
  ServiceOptionsSchema,
  type DescriptorProto,
  type EnumDescriptorProto,
  type FieldDescriptorProto,
  type FileDescriptorProto,
  type MethodDescriptorProto,
  type ServiceDescriptorProto,
} from "@bufbuild/protobuf/wkt";
import type { Notes } from "../graphql/notes";
import { doubleText, jsonNameOf, mapEntryNameOf } from "./descriptors";
import { GrpcImportError } from "./errors";
import type { Symbols } from "./symbols";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A number protobufjs reads back to the same text: no leading zeros, no hex or octal. */
const NUMBER = /^-?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The float and double defaults protoc writes as words. */
const FLOAT_WORDS = new Set(["inf", "-inf", "nan"]);

/** protoc's upper bound for a field number. */
const FIELD_NUMBER_MAX = 536_870_911;

/** INT32_MAX, which an enum's reserved range writes as `max`. */
const ENUM_VALUE_MAX = 2_147_483_647;

/** Words a type name cannot start with, because protobufjs reads them as a keyword where a type can stand. */
const RESERVED = new Set([
  "double",
  "float",
  "int32",
  "int64",
  "uint32",
  "uint64",
  "sint32",
  "sint64",
  "fixed32",
  "fixed64",
  "sfixed32",
  "sfixed64",
  "bool",
  "string",
  "bytes",
  "map",
  "optional",
  "required",
  "repeated",
  "oneof",
  "option",
  "message",
  "enum",
  "extend",
  "extensions",
  "reserved",
  "group",
  "stream",
  "returns",
  "rpc",
  "service",
  "syntax",
  "package",
  "import",
  "weak",
  "public",
  "edition",
]);

/** Identifiers protobufjs reads as a boolean or a number, so an enum default with one of these names cannot be written. */
const VALUE_WORDS = new Set(["true", "TRUE", "false", "FALSE", "inf", "INF", "Inf", "nan", "NAN", "Nan", "NaN"]);

const T = FieldDescriptorProto_Type;

const SCALAR_NAMES = new Map<FieldDescriptorProto_Type, string>([
  [T.DOUBLE, "double"],
  [T.FLOAT, "float"],
  [T.INT64, "int64"],
  [T.UINT64, "uint64"],
  [T.INT32, "int32"],
  [T.FIXED64, "fixed64"],
  [T.FIXED32, "fixed32"],
  [T.BOOL, "bool"],
  [T.STRING, "string"],
  [T.BYTES, "bytes"],
  [T.UINT32, "uint32"],
  [T.SFIXED32, "sfixed32"],
  [T.SFIXED64, "sfixed64"],
  [T.SINT32, "sint32"],
  [T.SINT64, "sint64"],
]);

/** The scalar types a map key can take. */
const MAP_KEY_TYPES = new Set<FieldDescriptorProto_Type>([
  T.INT32,
  T.INT64,
  T.UINT32,
  T.UINT64,
  T.SINT32,
  T.SINT64,
  T.FIXED32,
  T.FIXED64,
  T.SFIXED32,
  T.SFIXED64,
  T.BOOL,
  T.STRING,
]);

/** What a type name may name. */
type Accepts = "message" | "enum" | "message or enum";

const ACCEPTS_TEXT: Record<Accepts, string> = {
  message: "a message",
  enum: "an enum",
  "message or enum": "a message or an enum",
};

/** Where a field line stands, which decides its label. */
type Place = "message" | "oneof" | "extension";

/** A field's type as written, with the type it resolves to. */
interface TypeText {
  text: string;
  type: FieldDescriptorProto_Type;
}

/**
 * The file as .proto text. `symbols` holds every file reflection returned,
 * and `visible` names the files this one can see, so each type name is
 * written to resolve to the same definition. The caller has checked the
 * file's name and its imports: each is a path under proto/ with no quote,
 * backslash, or control character.
 */
export function printProto(
  file: FileDescriptorProto,
  symbols: Symbols,
  visible: ReadonlySet<string>,
  notes: Notes,
): string {
  return new Printer(file, symbols, visible, notes).print();
}

class Printer {
  private readonly file: FileDescriptorProto;
  private readonly symbols: Symbols;
  private readonly visible: ReadonlySet<string>;
  private readonly notes: Notes;
  private readonly proto3: boolean;
  /** Each leading comment, by its SourceCodeInfo path joined with commas. */
  private readonly comments = new Map<string, string>();
  private readonly lines: string[] = [];
  private depth = 0;
  private customOptions = false;

  constructor(file: FileDescriptorProto, symbols: Symbols, visible: ReadonlySet<string>, notes: Notes) {
    this.file = file;
    this.symbols = symbols;
    this.visible = visible;
    this.notes = notes;
    this.proto3 = file.syntax === "proto3";
    for (const location of file.sourceCodeInfo?.location ?? []) {
      const key = location.path.join(",");
      if (location.leadingComments.trim() !== "" && !this.comments.has(key)) {
        this.comments.set(key, location.leadingComments);
      }
    }
  }

  print(): string {
    const { file } = this;
    this.line(`syntax = "${this.proto3 ? "proto3" : "proto2"}";`);
    if (file.package !== "") {
      for (const part of file.package.split(".")) this.identifier(part, `a part of the package name ${JSON.stringify(file.package)}`);
      this.gap();
      this.line(`package ${file.package};`);
    }
    this.imports();
    const options = this.optionEntries(FileOptionsSchema, file.options, "the file");
    if (options.length > 0) this.gap();
    for (const entry of options) this.line(`option ${entry};`);

    file.service.forEach((service, index) => this.service(service, [6, index]));
    file.messageType.forEach((message, index) => this.message(message, file.package, [4, index]));
    file.enumType.forEach((enumType, index) => this.enumType(enumType, file.package, [5, index]));
    this.extensions(file.extension, file.package, [7]);

    if (this.customOptions) {
      this.notes.add(
        undefined,
        `Server reflection gave ${file.name} custom options. The .proto text import writes leaves them out, because the gateway reads none of them.`,
      );
    }
    return `${this.lines.join("\n")}\n`;
  }

  // ── Header ─────────────────────────────────────────────────────────────────

  private imports(): void {
    const { file } = this;
    const publics = new Set(file.publicDependency);
    const weaks = new Set(file.weakDependency);
    for (const index of [...publics, ...weaks]) {
      if (!Number.isInteger(index) || index < 0 || index >= file.dependency.length) {
        this.refuse(`it marks import number ${index} public or weak, and it has ${file.dependency.length} imports`);
      }
      if (publics.has(index) && weaks.has(index)) {
        this.refuse(`it marks its import of ${file.dependency[index] ?? ""} both public and weak`);
      }
    }
    if (file.dependency.length > 0) this.gap();
    file.dependency.forEach((dependency, index) => {
      const kind = publics.has(index) ? "public " : weaks.has(index) ? "weak " : "";
      this.line(`import ${kind}"${dependency}";`);
    });
  }

  // ── Services ───────────────────────────────────────────────────────────────

  private service(service: ServiceDescriptorProto, path: readonly number[]): void {
    const full = this.full(this.file.package, service.name, "a service");
    this.open(path, `service ${service.name} {`);
    for (const entry of this.optionEntries(ServiceOptionsSchema, service.options, `the service ${full}`)) {
      this.line(`option ${entry};`);
    }
    service.method.forEach((method, index) => this.method(method, full, [...path, 2, index]));
    this.close();
  }

  private method(method: MethodDescriptorProto, service: string, path: readonly number[]): void {
    const where = `the method ${service}.${method.name}`;
    this.identifier(method.name, `a method of ${service}`);
    const input = this.typeName(method.inputType, service, `the input of ${where}`, "message");
    const output = this.typeName(method.outputType, service, `the output of ${where}`, "message");
    const options = this.optionEntries(MethodOptionsSchema, method.options, where);
    const signature = `rpc ${method.name}(${method.clientStreaming ? "stream " : ""}${input}) returns (${method.serverStreaming ? "stream " : ""}${output})`;
    this.comment(path);
    if (options.length === 0) {
      this.line(`${signature};`);
      return;
    }
    this.line(`${signature} {`);
    this.depth += 1;
    for (const entry of options) this.line(`option ${entry};`);
    this.close();
  }

  // ── Messages ───────────────────────────────────────────────────────────────

  private message(message: DescriptorProto, scope: string, path: readonly number[]): void {
    const full = this.full(scope, message.name, "a message");
    if (message.options?.mapEntry === true) {
      this.refuse(`the message ${full} is a map entry that no map field in the same message uses`);
    }
    this.open(path, `message ${message.name} {`);
    for (const entry of this.optionEntries(MessageOptionsSchema, message.options, `the message ${full}`)) {
      this.line(`option ${entry};`);
    }
    const consumed = this.fields(message, full, path);
    message.nestedType.forEach((nested, index) => {
      if (!consumed.has(index)) this.message(nested, full, [...path, 3, index]);
    });
    message.enumType.forEach((enumType, index) => this.enumType(enumType, full, [...path, 4, index]));
    this.extensions(message.extension, full, [...path, 6]);
    this.messageRanges(message, full);
    this.close();
  }

  /** Prints the fields and oneofs in field order, and returns the nested types the map fields use. */
  private fields(message: DescriptorProto, full: string, path: readonly number[]): Set<number> {
    const consumed = new Set<number>();
    const real = this.realOneofs(message, full);
    const printed = new Set<number>();
    message.field.forEach((field, index) => {
      const oneof = isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex) ? field.oneofIndex : undefined;
      const members = oneof === undefined ? undefined : real.get(oneof);
      if (oneof !== undefined && members !== undefined) {
        if (printed.has(oneof)) return;
        printed.add(oneof);
        this.oneof(message, oneof, members, full, path);
        return;
      }
      const where = `the field ${full}.${field.name}`;
      const map = this.mapOf(field, message, full, where);
      if (typeof map === "string") this.refuse(`${where} names the map entry ${field.typeName.slice(1)}, but ${map}`);
      if (map !== undefined) {
        consumed.add(map.entry);
        this.comment([...path, 2, index]);
        this.line(this.fieldLine(field, { text: map.text, type: T.MESSAGE }, full, where, ""));
        return;
      }
      this.comment([...path, 2, index]);
      this.line(this.fieldLine(field, this.typeOf(field, full, where), full, where, this.labelOf(field, where, "message")));
    });
    return consumed;
  }

  /**
   * The oneofs a .proto file declares with a oneof block, each with its
   * fields' indexes. A synthetic oneof, the one protoc makes for a proto3
   * `optional` field, is left out: the field prints with its label.
   */
  private realOneofs(message: DescriptorProto, full: string): Map<number, number[]> {
    const members = new Map<number, number[]>();
    message.field.forEach((field, index) => {
      if (!isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex)) {
        if (field.proto3Optional) this.refuse(`the field ${full}.${field.name} is proto3 optional and in no oneof`);
        return;
      }
      if (field.oneofIndex < 0 || field.oneofIndex >= message.oneofDecl.length) {
        this.refuse(`the field ${full}.${field.name} is in oneof number ${field.oneofIndex}, which ${full} does not declare`);
      }
      const list = members.get(field.oneofIndex) ?? [];
      list.push(index);
      members.set(field.oneofIndex, list);
    });
    const real = new Map<number, number[]>();
    message.oneofDecl.forEach((oneof, index) => {
      const where = `the oneof ${full}.${oneof.name}`;
      const list = members.get(index) ?? [];
      if (list.length === 0) this.refuse(`${where} has no fields`);
      const optional = list.filter((each) => message.field[each]?.proto3Optional === true).length;
      if (optional === 0) {
        real.set(index, list);
        return;
      }
      if (optional !== list.length) this.refuse(`${where} mixes proto3 optional fields with other fields`);
      if (list.length !== 1 || !this.proto3) {
        this.refuse(`${where} holds proto3 optional fields, and only a proto3 oneof with one such field is valid`);
      }
    });
    return real;
  }

  private oneof(
    message: DescriptorProto,
    index: number,
    members: readonly number[],
    full: string,
    path: readonly number[],
  ): void {
    const oneof = message.oneofDecl[index];
    if (oneof === undefined) return;
    const name = `${full}.${oneof.name}`;
    this.identifier(oneof.name, `a oneof of ${full}`);
    this.comment([...path, 8, index]);
    this.line(`oneof ${oneof.name} {`);
    this.depth += 1;
    for (const entry of this.optionEntries(OneofOptionsSchema, oneof.options, `the oneof ${name}`)) {
      this.line(`option ${entry};`);
    }
    for (const fieldIndex of members) {
      const field = message.field[fieldIndex];
      if (field === undefined) continue;
      const where = `the field ${full}.${field.name}`;
      this.comment([...path, 2, fieldIndex]);
      this.line(this.fieldLine(field, this.typeOf(field, full, where), full, where, this.labelOf(field, where, "oneof")));
    }
    this.close();
  }

  /**
   * The map field's `map<K, V>` type and the index of its entry message.
   * It is undefined when the field names no map entry nested in the same
   * message, and a reason when the field names one but protoc would not
   * write the pair as a map field. A map field and its entry are the ones a
   * map field declares: the entry named for the field, with only a key and a
   * value and nothing else.
   */
  private mapOf(
    field: FieldDescriptorProto,
    message: DescriptorProto,
    full: string,
    where: string,
  ): { text: string; entry: number } | string | undefined {
    const index = message.nestedType.findIndex((nested) => field.typeName === `.${full}.${nested.name}`);
    const entry = message.nestedType[index];
    if (entry?.options?.mapEntry !== true) return undefined;
    const entryName = mapEntryNameOf(field.name);
    if (field.label !== FieldDescriptorProto_Label.REPEATED) return "it is not repeated";
    if (isFieldSet(field, FieldDescriptorProtoSchema.field.type) && field.type !== T.MESSAGE) {
      return "its type is not a message";
    }
    if (entry.name !== entryName) return `the entry is not named ${entryName}`;
    if (isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex)) return "it is in a oneof";
    if (isFieldSet(field, FieldDescriptorProtoSchema.field.defaultValue)) return "it has a default value";
    if (field.proto3Optional) return "it is proto3 optional";
    const [key, value] = entry.field;
    if (!isPlainMapEntry(entry) || key === undefined || value === undefined) {
      return "the entry holds more than a key = 1, a value = 2, and map_entry";
    }
    if (!MAP_KEY_TYPES.has(key.type)) {
      return `the key has the type ${SCALAR_NAMES.get(key.type) ?? `number ${key.type}`}, and a map key is an integer, a bool, or a string`;
    }
    if (value.type === T.GROUP) return "the value is a group";
    const keyName = SCALAR_NAMES.get(key.type) ?? "";
    const valueType = this.typeOf(value, full, `the value of ${where}`);
    return { text: `map<${keyName}, ${valueType.text}>`, entry: index };
  }

  /** `extensions` and `reserved` statements. Their ends are exclusive in the descriptor and inclusive in the text. */
  private messageRanges(message: DescriptorProto, full: string): void {
    const extensions: string[] = [];
    for (const range of message.extensionRange) {
      const text = this.range(range.start, range.end - 1, `an extension range of ${full}`);
      if (text === undefined) continue;
      if (range.options !== undefined) {
        this.note(`the options on the extension range ${text} of ${full}, because protobufjs does not read them`);
      }
      extensions.push(text);
    }
    if (extensions.length > 0) this.line(`extensions ${extensions.join(", ")};`);
    const reserved = message.reservedRange
      .map((range) => this.range(range.start, range.end - 1, `a reserved range of ${full}`))
      .filter((text) => text !== undefined);
    if (reserved.length > 0) this.line(`reserved ${reserved.join(", ")};`);
    this.reservedNames(message.reservedName, full);
  }

  /** One inclusive range as text, or undefined, with a note, when the text cannot carry it. */
  private range(start: number, end: number, what: string): string | undefined {
    if (start < 1 || end > FIELD_NUMBER_MAX) {
      this.note(`${what}, ${start} to ${end}, because it falls outside the field numbers 1 to 536,870,911`);
      return undefined;
    }
    if (end < start) {
      this.note(`${what}, because it holds no number`);
      return undefined;
    }
    return start === end ? `${start}` : `${start} to ${end}`;
  }

  private reservedNames(names: readonly string[], full: string): void {
    const kept = names.filter((name) => {
      if (IDENTIFIER.test(name)) return true;
      this.note(`the reserved name ${JSON.stringify(name)} of ${full}, because it is not a valid .proto identifier`);
      return false;
    });
    if (kept.length > 0) this.line(`reserved ${kept.map((name) => `"${name}"`).join(", ")};`);
  }

  // ── Fields ─────────────────────────────────────────────────────────────────

  /** One field line: label, type, name, number, and inline options. */
  private fieldLine(field: FieldDescriptorProto, type: TypeText, scope: string, where: string, label: string): string {
    this.identifier(field.name, `a field of ${scope === "" ? this.file.name : scope}`);
    if (!Number.isInteger(field.number) || field.number < 1 || field.number > FIELD_NUMBER_MAX) {
      this.refuse(`${where} has the number ${field.number}, and a field number runs from 1 to 536,870,911`);
    }
    const inline = [
      ...this.defaultEntry(field, type.type, where),
      ...this.jsonNameEntry(field, where),
      ...this.optionEntries(FieldOptionsSchema, field.options, where),
    ];
    const options = inline.length === 0 ? "" : ` [${inline.join(", ")}]`;
    return `${label}${type.text} ${field.name} = ${field.number}${options};`;
  }

  private labelOf(field: FieldDescriptorProto, where: string, place: Place): string {
    const { label } = field;
    if (place === "oneof") {
      if (label !== FieldDescriptorProto_Label.OPTIONAL) this.refuse(`${where} is in a oneof and is not optional`);
      return "";
    }
    if (label === FieldDescriptorProto_Label.REPEATED) return "repeated ";
    if (label === FieldDescriptorProto_Label.REQUIRED) {
      if (this.proto3) this.refuse(`${where} is required, which proto3 does not allow`);
      return "required ";
    }
    if (!this.proto3) {
      if (place === "extension" && field.proto3Optional) this.refuse(`${where} is proto3 optional in a proto2 file`);
      return "optional ";
    }
    return field.proto3Optional ? "optional " : "";
  }

  /** The field's type as written, with the type it names when the descriptor leaves `type` unset. */
  private typeOf(field: FieldDescriptorProto, scope: string, where: string): TypeText {
    const set = isFieldSet(field, FieldDescriptorProtoSchema.field.type);
    if (set && field.type === T.GROUP) {
      throw new GrpcImportError(
        "unsupported",
        `${where} in ${this.file.name} is a group, which import does not read. Change the group to a message field on the server, then import again.`,
        this.file.name,
      );
    }
    if (set && field.type !== T.MESSAGE && field.type !== T.ENUM) {
      const name = SCALAR_NAMES.get(field.type);
      if (name === undefined) this.refuse(`${where} has the unknown type number ${field.type}`);
      return { text: name, type: field.type };
    }
    if (field.typeName === "") this.refuse(`${where} names no type`);
    const accepts: Accepts = !set ? "message or enum" : field.type === T.MESSAGE ? "message" : "enum";
    const text = this.typeName(field.typeName, scope, where, accepts);
    const kind = this.symbols.find(field.typeName.slice(1), this.visible)?.kind;
    return { text, type: kind === "enum" ? T.ENUM : T.MESSAGE };
  }

  /** `default = …`, or nothing, with a note when the text cannot carry the default exactly. */
  private defaultEntry(field: FieldDescriptorProto, type: FieldDescriptorProto_Type, where: string): string[] {
    if (!isFieldSet(field, FieldDescriptorProtoSchema.field.defaultValue)) return [];
    const value = field.defaultValue;
    const drop = (why: string): string[] => {
      this.note(`the default value of ${where}, because ${why}`);
      return [];
    };
    if (this.proto3) return drop("proto3 has no default values");
    if (field.label === FieldDescriptorProto_Label.REPEATED) return drop("a repeated field has no default value");
    switch (type) {
      case T.MESSAGE:
      case T.GROUP:
        return drop("a message field has no default value");
      case T.ENUM:
        return IDENTIFIER.test(value) && !VALUE_WORDS.has(value)
          ? [`default = ${value}`]
          : drop(`protobufjs reads ${value} as something other than an enum value name`);
      case T.BOOL:
        return value === "true" || value === "false" ? [`default = ${value}`] : drop(`${value} is not true or false`);
      case T.STRING:
        return plainText(value) ? [`default = ${quotePieces(value)}`] : drop("it holds a backslash or a control character");
      case T.BYTES:
        return printableBytes(value) ? [`default = "${value}"`] : drop("it holds escaped bytes");
      default: {
        if (!NUMBER.test(value) && !FLOAT_WORDS.has(value)) return drop(`protobufjs does not read ${value} as a number`);
        const float = type === T.FLOAT || type === T.DOUBLE;
        const back = numberReadBack(value, float);
        if (back !== undefined && back !== value) {
          this.notes.add(
            undefined,
            `The .proto text import writes for ${this.file.name} changes the default value of ${where} from ${value} to ${back}. Both are the same number, and the second is how protoc writes it.`,
          );
        }
        // protobufjs reads -0 as 0 and -0.0 as -0.
        return [`default = ${float && value === "-0" ? "-0.0" : value}`];
      }
    }
  }

  /** `json_name = "…"` when the field sets one other than protoc's. An extension cannot set one. */
  private jsonNameEntry(field: FieldDescriptorProto, where: string): string[] {
    if (!isFieldSet(field, FieldDescriptorProtoSchema.field.jsonName)) return [];
    if (field.jsonName === jsonNameOf(field.name)) return [];
    if (field.extendee !== "") {
      this.note(`the JSON name ${field.jsonName} of ${where}, because an extension takes its JSON name from its field name`);
      return [];
    }
    const literal = stringLiteral(field.jsonName);
    if (literal === undefined) {
      this.note(`the JSON name of ${where}, because it holds a control character`);
      return [];
    }
    return [`json_name = ${literal}`];
  }

  // ── Enums ──────────────────────────────────────────────────────────────────

  private enumType(enumType: EnumDescriptorProto, scope: string, path: readonly number[]): void {
    const full = this.full(scope, enumType.name, "an enum");
    if (enumType.value.length === 0) this.refuse(`the enum ${full} has no values`);
    this.open(path, `enum ${enumType.name} {`);
    // Options come first, so allow_alias is set before a second name for one number.
    for (const entry of this.optionEntries(EnumOptionsSchema, enumType.options, `the enum ${full}`)) {
      this.line(`option ${entry};`);
    }
    enumType.value.forEach((value, index) => {
      const where = `the enum value ${full}.${value.name}`;
      this.identifier(value.name, `a value of ${full}`);
      if (value.name === "option" || value.name === "reserved") {
        this.refuse(`${where} is named ${value.name}, which protobufjs reads as a keyword`);
      }
      const inline = this.optionEntries(EnumValueOptionsSchema, value.options, where);
      this.comment([...path, 2, index]);
      this.line(`${value.name} = ${value.number}${inline.length === 0 ? "" : ` [${inline.join(", ")}]`};`);
    });
    const reserved: string[] = [];
    for (const range of enumType.reservedRange) {
      if (range.start < 0 || range.end < 0) {
        this.note(`the reserved range ${range.start} to ${range.end} of ${full}, because protobufjs does not read a negative reserved number`);
      } else if (range.end < range.start) {
        this.note(`a reserved range of ${full}, because it holds no number`);
      } else if (range.start === range.end) {
        reserved.push(`${range.start}`);
      } else {
        reserved.push(`${range.start} to ${range.end === ENUM_VALUE_MAX ? "max" : range.end}`);
      }
    }
    if (reserved.length > 0) this.line(`reserved ${reserved.join(", ")};`);
    this.reservedNames(enumType.reservedName, full);
    this.close();
  }

  // ── Extensions ─────────────────────────────────────────────────────────────

  /** `extend` blocks, one for each run of extensions of the same message. */
  private extensions(fields: readonly FieldDescriptorProto[], scope: string, path: readonly number[]): void {
    let open: string | undefined;
    fields.forEach((field, index) => {
      const where = `the extension ${scope === "" ? "" : `${scope}.`}${field.name}`;
      if (field.extendee === "") this.refuse(`${where} names no message to extend`);
      if (isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex)) this.refuse(`${where} is in a oneof`);
      if (field.extendee !== open) {
        if (open !== undefined) this.close();
        const extendee = this.typeName(field.extendee, scope, `the message ${where} extends`, "message");
        this.gap();
        this.line(`extend ${extendee} {`);
        this.depth += 1;
        open = field.extendee;
      }
      this.comment([...path, index]);
      this.line(this.fieldLine(field, this.typeOf(field, scope, where), scope, where, this.labelOf(field, where, "extension")));
    });
    if (open !== undefined) this.close();
  }

  // ── Options ────────────────────────────────────────────────────────────────

  /**
   * Each set option as `name = value`. A value the text cannot carry, such
   * as a list, a message, or bytes, is left out with a note. A custom option
   * arrives as an unknown field, and one note per file covers them.
   */
  private optionEntries<Desc extends DescMessage>(
    schema: Desc,
    options: MessageShape<Desc> | undefined,
    where: string,
  ): string[] {
    if (options === undefined) return [];
    const unknown = (options as { $unknown?: readonly unknown[] }).$unknown;
    if (unknown !== undefined && unknown.length > 0) this.customOptions = true;
    const values = options as unknown as Record<string, unknown>;
    const out: string[] = [];
    for (const field of schema.fields) {
      if (!isFieldSet(options, field)) continue;
      const value = values[field.localName];
      const drop = (why: string): void => this.note(`the option ${field.name} on ${where}, because ${why}`);
      if (field.fieldKind === "enum") {
        const name = typeof value === "number" ? field.enum.value[value]?.name : undefined;
        if (name === undefined) drop(`${String(value)} is not a value of ${field.enum.typeName}`);
        else out.push(`${field.name} = ${name}`);
      } else if (field.fieldKind !== "scalar") {
        drop("the text cannot carry a list, a map, or a message value");
      } else if (field.scalar === ScalarType.BYTES) {
        drop("the text cannot carry a bytes value");
      } else if (typeof value === "boolean" || typeof value === "bigint") {
        out.push(`${field.name} = ${value.toString()}`);
      } else if (typeof value === "number") {
        if (Number.isFinite(value)) out.push(`${field.name} = ${String(value)}`);
        else drop(`protobufjs does not read ${String(value)} as an option value`);
      } else if (typeof value === "string") {
        const literal = stringLiteral(value);
        if (literal === undefined) drop("its value holds a control character");
        else out.push(`${field.name} = ${literal}`);
      } else {
        drop("import cannot read its value");
      }
    }
    return out;
  }

  // ── Text ───────────────────────────────────────────────────────────────────

  /**
   * The shortest name for `ref` that resolves back to it from `scope`, or
   * the full name with its leading dot when no shorter one does.
   */
  private typeName(ref: string, scope: string, where: string, accepts: Accepts): string {
    if (!ref.startsWith(".")) this.refuse(`${where} is ${JSON.stringify(ref)}, which is not a full type name`);
    const full = ref.slice(1);
    const parts = full.split(".");
    if (!parts.every((part) => IDENTIFIER.test(part))) this.refuse(`${where} is ${JSON.stringify(ref)}, which is not a valid type name`);
    const found = this.symbols.find(full, this.visible);
    const fits =
      found !== undefined &&
      (found.kind === "message" ? accepts !== "enum" : found.kind === "enum" ? accepts !== "message" : false);
    if (!fits) this.refuse(`${where} is ${ref}, which is not ${ACCEPTS_TEXT[accepts]} that ${this.file.name} or its imports define`);
    for (let start = parts.length - 1; start >= 0; start -= 1) {
      if (RESERVED.has(parts[start] ?? "")) continue;
      const candidate = parts.slice(start).join(".");
      if (this.symbols.lookup(candidate, scope, this.visible)?.name === full) return candidate;
    }
    return ref;
  }

  /** The leading comment for the SourceCodeInfo path, as `//` lines. */
  private comment(path: readonly number[]): void {
    const text = this.comments.get(path.join(","));
    if (text === undefined) return;
    const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim());
    while (lines[0] === "") lines.shift();
    while (lines.at(-1) === "") lines.pop();
    const [first] = lines;
    if (first === undefined) return;
    // protobufjs strips a leading `*` or `/` from a comment's first line, so an empty line goes first.
    if (first.startsWith("*") || first.startsWith("/")) this.line("//");
    for (const line of lines) this.line(line === "" ? "//" : `// ${line}`);
  }

  /** A declaration that opens a block, after a blank line and its comment. */
  private open(path: readonly number[], text: string): void {
    this.gap();
    this.comment(path);
    this.line(text);
    this.depth += 1;
  }

  private close(): void {
    this.depth -= 1;
    this.line("}");
  }

  /** A blank line, unless the text starts, a block just opened, or a blank line precedes. */
  private gap(): void {
    const last = this.lines.at(-1);
    if (last !== undefined && last !== "" && !last.endsWith("{")) this.lines.push("");
  }

  private line(text: string): void {
    this.lines.push(`${"  ".repeat(this.depth)}${text}`);
  }

  private full(scope: string, name: string, what: string): string {
    this.identifier(name, what);
    return scope === "" ? name : `${scope}.${name}`;
  }

  private identifier(name: string, what: string): void {
    if (!IDENTIFIER.test(name)) this.refuse(`${what} is named ${JSON.stringify(name)}, which is not a valid .proto identifier`);
  }

  private note(what: string): void {
    this.notes.add(undefined, `The .proto text import writes for ${this.file.name} leaves out ${what}.`);
  }

  private refuse(detail: string): never {
    throw new GrpcImportError(
      "reflection",
      `Import cannot write ${this.file.name} from server reflection as .proto text: ${detail}. Import the server's .proto files instead.`,
      this.file.name,
    );
  }
}

/** A map entry exactly as protoc declares one: a key and a value, and nothing else. */
function isPlainMapEntry(entry: DescriptorProto): boolean {
  if (entry.options === undefined) return false;
  if (!equals(MessageOptionsSchema, entry.options, create(MessageOptionsSchema, { mapEntry: true }))) return false;
  if (entry.nestedType.length > 0 || entry.enumType.length > 0 || entry.extension.length > 0) return false;
  if (entry.oneofDecl.length > 0 || entry.extensionRange.length > 0) return false;
  if (entry.reservedRange.length > 0 || entry.reservedName.length > 0) return false;
  const [key, value] = entry.field;
  if (entry.field.length !== 2 || key === undefined || value === undefined) return false;
  return isPlainEntryField(key, "key", 1) && isPlainEntryField(value, "value", 2);
}

function isPlainEntryField(field: FieldDescriptorProto, name: string, number: number): boolean {
  if (field.name !== name || field.number !== number) return false;
  if (field.label !== FieldDescriptorProto_Label.OPTIONAL || !isFieldSet(field, FieldDescriptorProtoSchema.field.type)) {
    return false;
  }
  if (isFieldSet(field, FieldDescriptorProtoSchema.field.jsonName) && field.jsonName !== name) return false;
  if (isFieldSet(field, FieldDescriptorProtoSchema.field.oneofIndex)) return false;
  if (isFieldSet(field, FieldDescriptorProtoSchema.field.defaultValue)) return false;
  return field.options === undefined && !field.proto3Optional && field.extendee === "";
}

/**
 * The default_value import gives a number default after reading `value` back
 * from the text, or undefined when descriptors.ts leaves it out with a note
 * of its own. A float or double comes back in protoc's form: 1e+10 is
 * 10000000000.
 */
function numberReadBack(value: string, float: boolean): string | undefined {
  if (FLOAT_WORDS.has(value)) return value;
  const number = Number(value);
  if (float) return doubleText(number);
  return Number.isSafeInteger(number) ? String(number) : undefined;
}

/** Whether the text holds no backslash and no control character, so it can be written with no escape. */
function plainText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x5c) return false;
  }
  return true;
}

/** Whether a bytes default, which protoc C-escapes, is printable ASCII with nothing escaped. */
function printableBytes(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e || code === 0x5c || code === 0x22 || code === 0x27) return false;
  }
  return true;
}

const ESCAPES = new Map([
  ["\\", "\\\\"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
  ["\0", "\\0"],
]);

/** The string as a literal with the escapes protobufjs reads, or undefined when it holds another control character. */
function stringLiteral(text: string): string | undefined {
  let escaped = "";
  for (const char of text) {
    const escape = ESCAPES.get(char);
    if (escape !== undefined) {
      escaped += escape;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return undefined;
    escaped += char;
  }
  return quotePieces(escaped);
}

/**
 * The text as adjacent string literals. A literal that holds `"` is quoted
 * with `'`, and one that holds `'` with `"`. A new literal starts where the
 * text would need both.
 */
function quotePieces(text: string): string {
  const pieces: string[] = [];
  let piece = "";
  let double = false;
  let single = false;
  for (const char of text) {
    if ((char === '"' && single) || (char === "'" && double)) {
      pieces.push(double ? `'${piece}'` : `"${piece}"`);
      piece = "";
      double = false;
      single = false;
    }
    if (char === '"') double = true;
    if (char === "'") single = true;
    piece += char;
  }
  pieces.push(double ? `'${piece}'` : `"${piece}"`);
  return pieces.join(" ");
}
