// descriptors.ts: one parsed .proto file as the FileDescriptorProto protoc
// would write for it.
//
// protobufjs parses the text into reflection objects. This module copies them
// into descriptor messages in protoc's order: fields, nested messages, enums,
// extensions, and oneofs as the file declares them, with every field's JSON
// name set. Type names stay unresolved here, because resolving one needs the
// whole set of files: each reference becomes a PendingRef that set.ts
// resolves once every file is registered.
//
// Three things differ from protoc, and each is rare:
//   - A map field's entry message is added after the nested messages the
//     message declares, where protoc adds it at the map field's position.
//   - A default value that protobufjs cannot carry exactly (a string or bytes
//     default with an escape, or a 64-bit default past 2^53) is left out,
//     with a note.
//   - A custom option, such as (google.api.http), is left out, with a note.
//     The executor reads no custom option.
import protobuf from "protobufjs";
import type { Enum, Field, ITokenizerHandle, MapField, Method, NamespaceBase, OneOf, ReflectionObject, Service, Type } from "protobufjs";
import { create, fromJson, toBinary, type DescMessage, type JsonObject, type MessageShape } from "@bufbuild/protobuf";
import {
  DescriptorProtoSchema,
  DescriptorProto_ExtensionRangeSchema,
  DescriptorProto_ReservedRangeSchema,
  EnumDescriptorProtoSchema,
  EnumDescriptorProto_EnumReservedRangeSchema,
  EnumOptionsSchema,
  EnumValueDescriptorProtoSchema,
  EnumValueOptionsSchema,
  FieldDescriptorProtoSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldOptionsSchema,
  FileDescriptorProtoSchema,
  FileOptionsSchema,
  MessageOptionsSchema,
  MethodDescriptorProtoSchema,
  MethodOptionsSchema,
  OneofDescriptorProtoSchema,
  OneofOptionsSchema,
  ServiceDescriptorProtoSchema,
  ServiceOptionsSchema,
  type DescriptorProto,
  type EnumDescriptorProto,
  type FieldDescriptorProto,
  type FileDescriptorProto,
  type MethodDescriptorProto,
  type ServiceDescriptorProto,
} from "@bufbuild/protobuf/wkt";
import type { Notes } from "../graphql/notes";
import { GrpcImportError } from "./errors";
import { messageOf as errorText } from "./limits";
import type { ParsedProto } from "./source";

/** A type name the file writes, resolved once every file is registered. */
export interface PendingRef {
  /** The name as the file writes it: Money, google.protobuf.Timestamp, .a.B. */
  ref: string;
  /** The full name of the message, service, or package the name is written in. */
  scope: string;
  /** What holds the name, for a refusal: the field a_intel.ledger.v1.Entry.money. */
  holder: string;
  /** A field's type may name an enum. A method's types and an extendee must name a message. */
  accepts: "type" | "message";
  /** Writes the resolved full name, with no leading dot, into the descriptor. */
  resolve(name: string, kind: "message" | "enum"): void;
}

export interface BuiltFile {
  proto: FileDescriptorProto;
  pending: PendingRef[];
  /** Each definition's leading comment, by full name. An enum value is keyed <enum>.<value>. */
  comments: Map<string, string>;
  /** The custom options the file sets, which the descriptor set leaves out. */
  customOptions: Set<string>;
}

const SCALARS = new Map<string, FieldDescriptorProto_Type>([
  ["double", FieldDescriptorProto_Type.DOUBLE],
  ["float", FieldDescriptorProto_Type.FLOAT],
  ["int64", FieldDescriptorProto_Type.INT64],
  ["uint64", FieldDescriptorProto_Type.UINT64],
  ["int32", FieldDescriptorProto_Type.INT32],
  ["fixed64", FieldDescriptorProto_Type.FIXED64],
  ["fixed32", FieldDescriptorProto_Type.FIXED32],
  ["bool", FieldDescriptorProto_Type.BOOL],
  ["string", FieldDescriptorProto_Type.STRING],
  ["bytes", FieldDescriptorProto_Type.BYTES],
  ["uint32", FieldDescriptorProto_Type.UINT32],
  ["sfixed32", FieldDescriptorProto_Type.SFIXED32],
  ["sfixed64", FieldDescriptorProto_Type.SFIXED64],
  ["sint32", FieldDescriptorProto_Type.SINT32],
  ["sint64", FieldDescriptorProto_Type.SINT64],
]);

const INTEGER_TYPES = new Set([
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
]);

/** The highest field number protobuf allows: 2^29 - 1. */
const FIELD_NUMBER_MAX = 536_870_911;
/**
 * INT32_MAX, what `max` means in an enum's reserved range. protobufjs reads
 * `max` as FIELD_NUMBER_MAX in every range, so enumOf uses this only where
 * the text wrote `max`.
 */
const ENUM_VALUE_MAX = 2_147_483_647;

/** Options protobufjs keeps in a field's options that are not FieldOptions. */
const FIELD_PSEUDO_OPTIONS = ["default", "json_name", "proto3_optional"];

interface Build {
  file: string;
  syntax: "proto2" | "proto3";
  pending: PendingRef[];
  comments: Map<string, string>;
  customOptions: Set<string>;
  notes: Notes;
  /** String and bytes defaults the file writes with an escape, after protobufjs unescaped them. */
  escapedDefaults: Set<string>;
  /** The enum reserved ranges the file ends with `max`, keyed <enum>#<index in its reserved list>. */
  enumMaxRanges: Set<string>;
}

/** The file's descriptor, with every type reference pending. */
export function buildFile(parsed: ParsedProto, notes: Notes): BuiltFile {
  const pkg = parsed.package ?? "";
  const build: Build = {
    file: parsed.name,
    syntax: parsed.header.syntax,
    pending: [],
    comments: new Map(),
    customOptions: new Set(),
    notes,
    escapedDefaults: escapedDefaults(parsed.text),
    enumMaxRanges: enumMaxRanges(parsed.text, pkg),
  };
  const holder = packageNamespace(parsed.root, pkg);
  const prefix = pkg === "" ? "" : `${pkg}.`;

  const imports = parsed.header.imports;
  const proto = create(FileDescriptorProtoSchema, {
    name: parsed.name,
    dependency: imports.map((entry) => entry.path),
    publicDependency: indexesOf(imports, "public"),
    weakDependency: indexesOf(imports, "weak"),
  });
  if (pkg !== "") proto.package = pkg;
  if (parsed.header.syntax === "proto3") proto.syntax = "proto3";

  for (const child of holder.nestedArray) {
    if (isType(child)) {
      proto.messageType.push(messageOf(child, prefix, build));
    } else if (isEnum(child)) {
      proto.enumType.push(enumOf(child, prefix, build));
    } else if (isService(child)) {
      proto.service.push(serviceOf(child, prefix, build));
    } else if (isExtension(child)) {
      proto.extension.push(extensionOf(child, pkg, build));
    }
  }

  const fileOptions = { ...recordOf(parsed.root.options), ...(holder === parsed.root ? {} : recordOf(holder.options)) };
  const options = optionsOf(FileOptionsSchema, fileOptions, [], parsed.name, build);
  if (options !== undefined) proto.options = options;
  return { proto, pending: build.pending, comments: build.comments, customOptions: build.customOptions };
}

/** protoc's JSON name for a field: foo_bar_baz is fooBarBaz. */
export function jsonNameOf(name: string): string {
  let out = "";
  let upper = false;
  for (const char of name) {
    if (char === "_") {
      upper = true;
    } else {
      out += upper ? char.toUpperCase() : char;
      upper = false;
    }
  }
  return out;
}

/** protoc's name for a map field's entry message: foo_bar is FooBarEntry. */
export function mapEntryNameOf(name: string): string {
  let out = "";
  let upper = true;
  for (const char of name) {
    if (char === "_") {
      upper = true;
    } else {
      out += upper ? char.toUpperCase() : char;
      upper = false;
    }
  }
  return `${out}Entry`;
}

// ── Messages ─────────────────────────────────────────────────────────────────

function messageOf(type: Type, scope: string, build: Build): DescriptorProto {
  const full = `${scope}${type.name}`;
  if ((type as { group?: boolean }).group === true) {
    throw new GrpcImportError(
      "unsupported",
      `${build.file} declares the group ${full}. Import does not read groups, so declare a message and a message field in its place.`,
      build.file,
    );
  }
  keepComment(build, full, type.comment);
  const message = create(DescriptorProtoSchema, { name: type.name });
  // protobufjs wraps a proto3 optional extension in a oneof, as it does a field. protoc makes no oneof for it.
  const fieldOneofs = type.oneofsArray.filter((oneof) => !oneof.fieldsArray.some((field) => typeof field.extend === "string"));
  const [realOneofs, syntheticOneofs] = partitionOneofs(fieldOneofs);
  const oneofs = [...realOneofs, ...syntheticOneofs];
  const mapEntries: DescriptorProto[] = [];

  for (const field of type.fieldsArray) {
    // protobufjs adds a copy of each extension to the message it extends, named with a leading dot.
    if (field.name.startsWith(".")) continue;
    const where = `${full}.${field.name}`;
    checkNumber(field, `the field ${where}`, build);
    keepComment(build, where, field.comment);
    const descriptor = fieldOf(field, full, where, build);
    if (field.partOf !== null) descriptor.oneofIndex = oneofs.indexOf(field.partOf);
    if (isMap(field)) mapEntries.push(mapEntryOf(field, full, descriptor, build));
    message.field.push(descriptor);
  }
  checkJsonNames(message, full, build);

  for (const child of type.nestedArray) {
    if (isType(child)) {
      message.nestedType.push(messageOf(child, `${full}.`, build));
    } else if (isEnum(child)) {
      message.enumType.push(enumOf(child, `${full}.`, build));
    } else if (isExtension(child)) {
      message.extension.push(extensionOf(child, full, build));
    }
  }
  message.nestedType.push(...mapEntries);

  for (const oneof of oneofs) {
    keepComment(build, `${full}.${oneof.name}`, oneof.comment);
    const decl = create(OneofDescriptorProtoSchema, { name: oneof.name });
    const options = optionsOf(OneofOptionsSchema, recordOf(oneof.options), [], `${full}.${oneof.name}`, build);
    if (options !== undefined) decl.options = options;
    message.oneofDecl.push(decl);
  }

  // protobufjs keeps ranges with an inclusive end. A message's ranges end one past the last number.
  for (const [start = 0, end = start] of type.extensions ?? []) {
    message.extensionRange.push(create(DescriptorProto_ExtensionRangeSchema, { start, end: end + 1 }));
  }
  for (const entry of type.reserved ?? []) {
    if (typeof entry === "string") {
      message.reservedName.push(entry);
    } else {
      const [start = 0, end = start] = entry;
      message.reservedRange.push(create(DescriptorProto_ReservedRangeSchema, { start, end: end + 1 }));
    }
  }

  const messageOptions = recordOf(type.options);
  // protoc sets map_entry only on the entry message it makes for a map field. Written by hand, it is refused.
  if (messageOptions?.map_entry === true) {
    throw new GrpcImportError(
      "invalid",
      `${build.file} sets map_entry on the message ${full}. protoc sets it only on the entry message it makes for a map field, so remove the option and declare a map<K, V> field instead.`,
      build.file,
    );
  }
  const options = optionsOf(MessageOptionsSchema, messageOptions, [], full, build);
  if (options !== undefined) message.options = options;
  return message;
}

/** Real oneofs first, then the ones protobufjs made for proto3 optional fields, as protoc orders them. */
function partitionOneofs(oneofs: readonly OneOf[]): [OneOf[], OneOf[]] {
  const real: OneOf[] = [];
  const synthetic: OneOf[] = [];
  for (const oneof of oneofs) {
    const [only] = oneof.fieldsArray;
    const isSynthetic = oneof.fieldsArray.length === 1 && only !== undefined && recordOf(only.options)?.proto3_optional === true;
    (isSynthetic ? synthetic : real).push(oneof);
  }
  return [real, synthetic];
}

/** Two fields with one JSON name cannot both appear in the message's JSON form, so the file is refused. */
function checkJsonNames(message: DescriptorProto, full: string, build: Build): void {
  const byJsonName = new Map<string, string>();
  for (const field of message.field) {
    const other = byJsonName.get(field.jsonName);
    if (other === undefined) {
      byJsonName.set(field.jsonName, field.name);
      continue;
    }
    throw new GrpcImportError(
      "invalid",
      `${build.file} gives the fields ${other} and ${field.name} of ${full} the same JSON name, ${field.jsonName}. The message's JSON form cannot hold both, so rename one or set json_name.`,
      build.file,
    );
  }
}

/** Refuses a field or extension number protoc refuses. `holder` names it: the field p.M.x or the extension p.x. */
function checkNumber(field: Field, holder: string, build: Build): void {
  const { id } = field;
  if (Number.isInteger(id) && id >= 1 && id <= FIELD_NUMBER_MAX && (id < 19_000 || id > 19_999)) return;
  throw new GrpcImportError(
    "invalid",
    `${build.file} numbers ${holder} ${id}. A field number runs from 1 to 536,870,911 and skips 19,000 to 19,999, which protobuf reserves, so renumber it.`,
    build.file,
  );
}

// ── Fields ───────────────────────────────────────────────────────────────────

/** The field's descriptor. A type reference is left pending. */
function fieldOf(field: Field, scope: string, where: string, build: Build): FieldDescriptorProto {
  const options = recordOf(field.options);
  const jsonName = options?.json_name;
  const descriptor = create(FieldDescriptorProtoSchema, {
    name: field.name,
    number: field.id,
    label: labelOf(field, where, build),
    jsonName: typeof jsonName === "string" ? jsonName : jsonNameOf(field.name),
  });
  if (isMap(field)) {
    descriptor.type = FieldDescriptorProto_Type.MESSAGE;
    descriptor.typeName = `.${scope}.${mapEntryNameOf(field.name)}`;
  } else {
    setType(descriptor, field.type, scope, where, build);
  }
  const defaultValue = defaultOf(field, where, build);
  if (defaultValue !== undefined) descriptor.defaultValue = defaultValue;
  if (options?.proto3_optional === true) descriptor.proto3Optional = true;
  const fieldOptions = optionsOf(FieldOptionsSchema, options, FIELD_PSEUDO_OPTIONS, where, build);
  if (fieldOptions !== undefined) descriptor.options = fieldOptions;
  return descriptor;
}

function labelOf(field: Field, where: string, build: Build): FieldDescriptorProto_Label {
  if (field.repeated || isMap(field)) return FieldDescriptorProto_Label.REPEATED;
  if ((field as { rule?: string }).rule !== "required") return FieldDescriptorProto_Label.OPTIONAL;
  if (build.syntax === "proto3") {
    throw new GrpcImportError(
      "invalid",
      `${build.file} marks ${where} required. proto3 has no required fields, so remove the label.`,
      build.file,
    );
  }
  return FieldDescriptorProto_Label.REQUIRED;
}

/** A scalar's type, or a pending reference that sets TYPE_MESSAGE or TYPE_ENUM and the name. */
function setType(descriptor: FieldDescriptorProto, type: string, scope: string, where: string, build: Build): void {
  const scalar = SCALARS.get(type);
  if (scalar !== undefined) {
    descriptor.type = scalar;
    return;
  }
  build.pending.push({
    ref: type,
    scope,
    holder: `the field ${where}`,
    accepts: "type",
    resolve(name, kind) {
      descriptor.type = kind === "enum" ? FieldDescriptorProto_Type.ENUM : FieldDescriptorProto_Type.MESSAGE;
      descriptor.typeName = `.${name}`;
    },
  });
}

/** The entry message protoc makes for a map field: key = 1 and value = 2, with map_entry set. */
function mapEntryOf(field: MapField, scope: string, mapField: FieldDescriptorProto, build: Build): DescriptorProto {
  const key = create(FieldDescriptorProtoSchema, {
    name: "key",
    number: 1,
    label: FieldDescriptorProto_Label.OPTIONAL,
    jsonName: "key",
  });
  setType(key, field.keyType, scope, `${scope}.${field.name}`, build);
  const value = create(FieldDescriptorProtoSchema, {
    name: "value",
    number: 2,
    label: FieldDescriptorProto_Label.OPTIONAL,
    jsonName: "value",
  });
  setType(value, field.type, scope, `${scope}.${field.name}`, build);
  return create(DescriptorProtoSchema, {
    name: mapField.typeName.slice(scope.length + 2),
    field: [key, value],
    options: { mapEntry: true },
  });
}

function extensionOf(field: Field, scope: string, build: Build): FieldDescriptorProto {
  const where = scope === "" ? field.name : `${scope}.${field.name}`;
  checkNumber(field, `the extension ${where}`, build);
  keepComment(build, where, field.comment);
  const descriptor = fieldOf(field, scope, where, build);
  const extendee = field.extend ?? "";
  build.pending.push({
    ref: extendee,
    scope,
    holder: `the extension ${where}`,
    accepts: "message",
    resolve(name) {
      descriptor.extendee = `.${name}`;
    },
  });
  return descriptor;
}

/**
 * A proto2 default as protoc writes it in default_value, or undefined when
 * the field has none or protobufjs cannot carry it exactly. proto3 has no
 * default values, so one there is refused.
 */
function defaultOf(field: Field, where: string, build: Build): string | undefined {
  const raw: unknown = recordOf(field.options)?.default;
  if (raw === undefined) return undefined;
  if (build.syntax === "proto3") {
    throw new GrpcImportError(
      "invalid",
      `${build.file} gives ${where} a default value. proto3 has no default values, so remove it.`,
      build.file,
    );
  }
  const drop = (why: string): undefined => {
    build.notes.add(
      undefined,
      `${where} has a default value ${why}, so the descriptor set leaves it out. A call is unchanged: the gateway sends and returns only the fields a message sets.`,
    );
    return undefined;
  };
  if (typeof raw === "boolean") return String(raw);
  if (typeof raw === "number") {
    if (Number.isNaN(raw)) return "nan";
    if (raw === Infinity) return "inf";
    if (raw === -Infinity) return "-inf";
    if (INTEGER_TYPES.has(field.type)) {
      return Number.isSafeInteger(raw) ? String(raw) : drop("past 2^53, which protobufjs rounds");
    }
    return field.type === "float" ? floatText(raw) : doubleText(raw);
  }
  if (typeof raw !== "string") return drop("import cannot read");
  if ((field.type === "string" || field.type === "bytes") && build.escapedDefaults.has(raw)) {
    return drop("written with an escape, which protobufjs does not read exactly");
  }
  return field.type === "bytes" ? cEscape(raw) : raw;
}

/**
 * A double as protoc writes it in default_value: C's %.15g, or %.17g when
 * %.15g does not read back as the same number (SimpleDtoa). 1e20 is
 * "1e+20", 0.1 is "0.1", and -0 is "-0".
 */
export function doubleText(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (Object.is(value, -0)) return "-0";
  const short = formatG(value, 15);
  return Number(short) === value ? short : formatG(value, 17);
}

/** FLT_MAX, the largest finite float32. */
const FLOAT_MAX = 3.4028234663852886e38;
/**
 * protoc's MAX_FLOAT_AS_DOUBLE_ROUNDED. A double above FLT_MAX and no larger
 * than this rounds down to FLT_MAX. A larger one becomes inf.
 */
const FLOAT_MAX_ROUNDED = 3.4028235677973366e38;

/**
 * A float as protoc writes it in default_value. protoc casts the double it
 * parsed to float32 (SafeDoubleToFloat), then writes that float with C's
 * %.6g, or %.9g when %.6g does not read back as the same float (SimpleFtoa).
 * So 0.3333333333333333 is "0.333333343", 1e10 is "1e+10", and 1e39 is "inf".
 */
export function floatText(value: number): string {
  const float = toFloat32(value);
  if (Number.isNaN(float)) return "nan";
  if (float === Infinity) return "inf";
  if (float === -Infinity) return "-inf";
  if (Object.is(float, -0)) return "-0";
  const short = formatG(float, 6);
  return Math.fround(Number(short)) === float ? short : formatG(float, 9);
}

/** A double cast to float32 the way protoc's SafeDoubleToFloat casts it. */
function toFloat32(value: number): number {
  if (value > FLOAT_MAX) {
    return value <= FLOAT_MAX_ROUNDED ? FLOAT_MAX : Infinity;
  }
  if (value < -FLOAT_MAX) {
    return value >= -FLOAT_MAX_ROUNDED ? -FLOAT_MAX : -Infinity;
  }
  return Math.fround(value);
}

/**
 * C's %.<precision>g for a finite number. It rounds the number's exact binary
 * value and breaks an exact tie to even, as C does. JavaScript's toExponential
 * breaks a tie upward instead, so 0.0001220703125 (2^-13) at nine digits
 * would come out "0.000122070313" where C writes "0.000122070312".
 */
function formatG(value: number, precision: number): string {
  if (value === 0) return "0";
  if (value < 0) return `-${formatG(-value, precision)}`;
  const { coefficient, scale } = exactDecimal(value);
  const digits = coefficient.toString();
  let exponent = digits.length - 1 - scale;
  let kept: bigint;
  if (digits.length <= precision) {
    kept = coefficient * 10n ** BigInt(precision - digits.length);
  } else {
    const unit = 10n ** BigInt(digits.length - precision);
    const rest = coefficient % unit;
    const half = unit / 2n;
    kept = coefficient / unit;
    if (rest > half || (rest === half && kept % 2n === 1n)) kept += 1n;
  }
  let text = kept.toString();
  if (text.length > precision) {
    // Rounding carried into a new digit, as 9.99 does at two digits.
    text = text.slice(0, precision);
    exponent += 1;
  }
  if (exponent < -4 || exponent >= precision) {
    const sign = exponent < 0 ? "-" : "+";
    const power = String(Math.abs(exponent)).padStart(2, "0");
    return `${pointed(text.slice(0, 1), text.slice(1))}e${sign}${power}`;
  }
  if (exponent < 0) return pointed("0", `${"0".repeat(-exponent - 1)}${text}`);
  return pointed(text.slice(0, exponent + 1), text.slice(exponent + 1));
}

/**
 * whole.fraction with the fraction's trailing zeros dropped. When no digit is
 * left after the point, the point goes too.
 */
function pointed(whole: string, fraction: string): string {
  const kept = fraction.replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}

/** A positive finite double's exact value as coefficient / 10^scale. */
function exactDecimal(value: number): { coefficient: bigint; scale: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xf_ffff_ffff_ffffn;
  // A subnormal has no implicit leading bit. Its exponent is the smallest
  // normal's.
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const power = (biased === 0 ? 1 : biased) - 1075;
  if (power >= 0) return { coefficient: mantissa << BigInt(power), scale: 0 };
  // m / 2^k is m * 5^k / 10^k.
  return { coefficient: mantissa * 5n ** BigInt(-power), scale: -power };
}

/** The string and bytes defaults a file writes with a backslash, as protobufjs unescapes them. */
function escapedDefaults(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(/\bdefault\s*=\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/g)) {
    const literal = match[1] ?? match[2] ?? "";
    if (literal.includes("\\")) out.add(protobuf.tokenize.unescape(literal));
  }
  return out;
}

/** protoc's C escaping of a bytes default. The value holds only what the file typed, with no escapes. */
function cEscape(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x27) out += "\\'";
    else if (byte === 0x5c) out += "\\\\";
    else if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return out;
}

// ── Enums ────────────────────────────────────────────────────────────────────

function enumOf(type: Enum, scope: string, build: Build): EnumDescriptorProto {
  const full = `${scope}${type.name}`;
  keepComment(build, full, type.comment);
  const descriptor = create(EnumDescriptorProtoSchema, { name: type.name });
  for (const [name, number] of Object.entries(type.values)) {
    keepComment(build, `${full}.${name}`, type.comments[name]);
    const value = create(EnumValueDescriptorProtoSchema, { name, number });
    const options = optionsOf(EnumValueOptionsSchema, recordOf(type.valuesOptions?.[name]), [], `${full}.${name}`, build);
    if (options !== undefined) value.options = options;
    descriptor.value.push(value);
  }
  const [first] = descriptor.value;
  if (build.syntax === "proto3" && first !== undefined && first.number !== 0) {
    throw new GrpcImportError(
      "invalid",
      `${build.file} starts the enum ${full} at ${first.name} = ${first.number}. A proto3 enum's first value must be 0, so add a value such as ${constantCaseOf(type.name)}_UNSPECIFIED = 0 before it.`,
      build.file,
    );
  }
  (type.reserved ?? []).forEach((entry, index) => {
    if (typeof entry === "string") {
      descriptor.reservedName.push(entry);
      return;
    }
    const [start = 0, end = start] = entry;
    const max = build.enumMaxRanges.has(`${full}#${index}`);
    descriptor.reservedRange.push(create(EnumDescriptorProto_EnumReservedRangeSchema, { start, end: max ? ENUM_VALUE_MAX : end }));
  });
  const options = optionsOf(EnumOptionsSchema, recordOf(type.options), [], full, build);
  if (options !== undefined) descriptor.options = options;
  return descriptor;
}

/** An enum name in constant case, as a value name starts: HTTPCode is HTTP_CODE. */
function constantCaseOf(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
}

interface Block {
  kind: "message" | "enum" | "other";
  full: string;
  /** The items the enum's reserved statements have listed so far. */
  entries: number;
}

/**
 * The enum reserved ranges the text ends with `max`, keyed
 * <enum>#<index in its reserved list>. protobufjs reads `max` and 536870911
 * as the same number, so only the text tells them apart. The index counts
 * every item of every reserved statement in the enum, names included, in the
 * order protobufjs lists them.
 */
function enumMaxRanges(text: string, pkg: string): Set<string> {
  const out = new Set<string>();
  const tokens = protobuf.tokenize(text, true);
  const blocks: Block[] = [];
  let last = "";
  let beforeLast = "";
  for (let token = tokens.next(); token !== null; token = tokens.next()) {
    const top = blocks[blocks.length - 1];
    if (token === '"' || token === "'") {
      // The string's contents, then its closing quote.
      tokens.next();
      tokens.next();
    } else if (token === "{") {
      const opens = beforeLast === "message" || beforeLast === "enum";
      if (opens && (top === undefined || top.kind === "message")) {
        const scope = top === undefined ? (pkg === "" ? "" : `${pkg}.`) : `${top.full}.`;
        blocks.push({ kind: beforeLast === "message" ? "message" : "enum", full: `${scope}${last}`, entries: 0 });
      } else {
        blocks.push({ kind: "other", full: "", entries: 0 });
      }
    } else if (token === "}") {
      blocks.pop();
    } else if (token === "reserved" && top?.kind === "enum" && (last === "{" || last === ";" || last === "}")) {
      readReserved(tokens, top, out);
      token = ";";
    }
    beforeLast = last;
    last = token;
  }
  return out;
}

/** Reads an enum's reserved statement up to its semicolon, and adds each range that ends with `max`. */
function readReserved(tokens: ITokenizerHandle, block: Block, out: Set<string>): void {
  let item: string[] = [];
  const close = (): void => {
    const [, to, end = ""] = item;
    if (item.length === 3 && to === "to" && /^(?:max|MAX|Max)$/.test(end)) out.add(`${block.full}#${block.entries}`);
    block.entries += 1;
    item = [];
  };
  for (let token = tokens.next(); token !== null && token !== ";"; token = tokens.next()) {
    if (token === ",") {
      close();
    } else if (token === '"' || token === "'") {
      tokens.next();
      tokens.next();
      item.push(token);
    } else {
      item.push(token);
    }
  }
  close();
}

// ── Services ─────────────────────────────────────────────────────────────────

function serviceOf(service: Service, scope: string, build: Build): ServiceDescriptorProto {
  const full = `${scope}${service.name}`;
  keepComment(build, full, service.comment);
  const descriptor = create(ServiceDescriptorProtoSchema, { name: service.name });
  for (const method of service.methodsArray) descriptor.method.push(methodOf(method, full, build));
  const options = optionsOf(ServiceOptionsSchema, recordOf(service.options), [], full, build);
  if (options !== undefined) descriptor.options = options;
  return descriptor;
}

function methodOf(method: Method, service: string, build: Build): MethodDescriptorProto {
  const full = `${service}.${method.name}`;
  keepComment(build, full, method.comment);
  const descriptor = create(MethodDescriptorProtoSchema, { name: method.name });
  const pend = (ref: string, which: "request" | "response"): void => {
    build.pending.push({
      ref,
      scope: service,
      holder: `the ${which} type of ${service}/${method.name}`,
      accepts: "message",
      resolve(name) {
        if (which === "request") descriptor.inputType = `.${name}`;
        else descriptor.outputType = `.${name}`;
      },
    });
  };
  pend(method.requestType, "request");
  pend(method.responseType, "response");
  if (method.requestStream === true) descriptor.clientStreaming = true;
  if (method.responseStream === true) descriptor.serverStreaming = true;
  const options = optionsOf(MethodOptionsSchema, recordOf(method.options), [], full, build);
  if (options !== undefined) descriptor.options = options;
  return descriptor;
}

// ── Options and helpers ──────────────────────────────────────────────────────

/**
 * The built-in options as the options message, or undefined when none is set.
 * A custom option is left out and recorded. A feature, an option protobuf
 * does not define, and a value of the wrong type are each refused in their
 * own words.
 */
function optionsOf<Desc extends DescMessage>(
  schema: Desc,
  raw: Record<string, unknown> | undefined,
  skip: readonly string[],
  where: string,
  build: Build,
): MessageShape<Desc> | undefined {
  if (raw === undefined) return undefined;
  const rest: JsonObject = {};
  for (const [key, value] of Object.entries(raw)) {
    if (skip.includes(key)) continue;
    if (key.startsWith("(")) {
      build.customOptions.add(key.slice(0, key.indexOf(")") + 1));
      continue;
    }
    if (key === "features") {
      // protobufjs reads features in any syntax. protoc refuses them outside an editions file.
      const [feature] = Object.keys(recordOf(value) ?? {});
      throw new GrpcImportError(
        "invalid",
        `${build.file} sets ${feature === undefined ? "features" : `features.${feature}`} on ${where}. Features are valid only in an editions file, and import reads proto2 and proto3 files, so remove the option.`,
        build.file,
      );
    }
    rest[key] = value as JsonObject[string];
  }
  if (Object.keys(rest).length === 0) return undefined;
  let options: MessageShape<Desc>;
  try {
    options = fromJson(schema, rest);
  } catch (error) {
    const known = new Set(schema.fields.flatMap((field) => [field.name, field.jsonName]));
    if (Object.keys(rest).every((key) => known.has(key))) {
      throw new GrpcImportError(
        "invalid",
        `${build.file} sets an option on ${where} to a value of the wrong type for ${schema.typeName}: ${errorText(error)}. Correct the value.`,
        build.file,
      );
    }
    throw new GrpcImportError(
      "unsupported",
      `${build.file} sets an option on ${where} that ${schema.typeName} does not define: ${errorText(error)}. Correct or remove the option.`,
      build.file,
    );
  }
  return toBinary(schema, options).length === 0 ? undefined : options;
}

function keepComment(build: Build, name: string, comment: string | null | undefined): void {
  const text = comment?.trim();
  if (text) build.comments.set(name, text);
}

function indexesOf(imports: readonly { kind: string }[], kind: string): number[] {
  const out: number[] = [];
  imports.forEach((entry, index) => {
    if (entry.kind === kind) out.push(index);
  });
  return out;
}

/** The namespace that holds the file's top-level definitions: its package, or the root. */
function packageNamespace(root: NamespaceBase, pkg: string): NamespaceBase {
  let holder = root;
  if (pkg === "") return holder;
  for (const part of pkg.split(".")) {
    const next = holder.nested?.[part];
    if (next === undefined || !("nestedArray" in next)) return holder;
    holder = next as NamespaceBase;
  }
  return holder;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isType(value: ReflectionObject): value is Type {
  return value instanceof protobuf.Type;
}

function isEnum(value: ReflectionObject): value is Enum {
  return value instanceof protobuf.Enum;
}

function isService(value: ReflectionObject): value is Service {
  return value instanceof protobuf.Service;
}

function isExtension(value: ReflectionObject): value is Field {
  return value instanceof protobuf.Field && typeof value.extend === "string";
}

/**
 * protobufjs types a message's fields as Field, but a map field is a
 * MapField, and MapField does not extend Field. The intersection lets the
 * predicate narrow a Field.
 */
function isMap(field: Field): field is Field & MapField {
  return field.map;
}
