// json-schema.ts: the JSON Schema each message maps to, by the proto3 JSON
// mapping (mcp-studio-spec, Mapping (gRPC)).
//
// The executor turns a tool's arguments into the request with fromJson and
// the response into JSON with toJson (execute/grpc/descriptors.ts). Each
// schema below describes what those two functions accept and write:
// - Properties take each field's JSON name, as toJson writes it.
// - A 64-bit integer is a decimal string. A 32-bit integer is a number.
// - A float or double is a number, or NaN, Infinity, or -Infinity as a string.
// - bytes are base64.
// - An enum is one of its value names. In a response, an open enum can also
//   be a number the definition does not name, sent by a newer server.
// - A well-known type takes its own JSON form. A Timestamp is an RFC 3339
//   string, a Duration is a string such as "1.5s", and an Any is an object
//   with an @type URL. A request's Any must carry an @type that ends in a
//   type name, because fromJson refuses one that is missing or empty. A
//   response's Any can be {}, as toJson writes an empty Any.
// - A map is an object keyed by the key's JSON form. In a request, an
//   integer key must be a decimal integer and a bool key must be "true" or
//   "false", so the schema refuses a key fromJson cannot read. That is
//   stricter than fromJson, which also reads "0x10" as an int32 key. The
//   encoder still checks each key's range. A response's keys are not
//   constrained, because toJson writes them.
// - A oneof allows at most one of its fields.
// - A response requires each field toJson always writes: the fields with
//   implicit presence (lists and maps among them) and proto2 required fields.
//   A request requires only the proto2 required fields.
//
// A message that refers to itself is expanded RECURSION_DEPTH times, then
// cut to a stub with a note. Past TOOL_NODES_SOFT_MAX nodes in one tool, each
// further message becomes a stub. Past EXPANSION_NODES_MAX nodes in the whole
// import, import is refused.
import { ScalarType, type DescEnum, type DescField, type DescMessage } from "@bufbuild/protobuf";
import { FeatureSet_FieldPresence, isWrapperDesc } from "@bufbuild/protobuf/wkt";
import type { Notes } from "../graphql/notes";
import { GrpcImportError } from "./errors";
import { count, DEPTH_MAX, EXPANSION_NODES_MAX, RECURSION_DEPTH, TOOL_NODES_SOFT_MAX } from "./limits";

/**
 * The part of JSON Schema that gRPC import writes. It is a type alias because
 * only an alias gets an implicit index signature, and the contract's
 * inputSchema and outputSchema take `{ [k: string]: unknown }`.
 */
export type JsonSchema = {
  type?: string;
  description?: string;
  enum?: string[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  contentEncoding?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  patternProperties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
  deprecated?: boolean;
};

/** A JSON Schema whose type is object, as inputSchema and outputSchema must be. */
export type ObjectSchema = JsonSchema & { type: "object" };

/** Which way a message travels: a request toJson never writes, or a response fromJson never reads. */
export type Direction = "input" | "output";

const NON_FINITE = ["NaN", "Infinity", "-Infinity"];

/** A scalar's JSON form, as a new object each time so no two schemas share one. */
function scalarSchema(scalar: ScalarType): JsonSchema {
  switch (scalar) {
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return { anyOf: [{ type: "number" }, { type: "string", enum: [...NON_FINITE] }] };
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
      return { type: "integer", minimum: -2147483648, maximum: 2147483647 };
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      return { type: "integer", minimum: 0, maximum: 4294967295 };
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
      return { type: "string", format: "int64", pattern: "^-?[0-9]+$" };
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return { type: "string", format: "uint64", pattern: "^[0-9]+$" };
    case ScalarType.BOOL:
      return { type: "boolean" };
    case ScalarType.STRING:
      return { type: "string" };
    case ScalarType.BYTES:
      return { type: "string", contentEncoding: "base64" };
  }
}

/**
 * A type URL that ends in a type name. fromJson reads the name after the
 * last slash and refuses an Any whose name is empty.
 */
const TYPE_URL_PATTERN = "^(.*/)?[^/]+$";

/**
 * An Any's JSON form. A request's Any needs an @type, because fromJson
 * refuses a non-empty Any without one. It also accepts {}, but an empty Any
 * says nothing that leaving the field out does not. A response's Any can
 * be {}.
 */
function anySchema(direction: Direction): JsonSchema {
  if (direction === "output") {
    return { type: "object", properties: { "@type": { type: "string" } }, additionalProperties: true };
  }
  const typeUrl: JsonSchema = {
    type: "string",
    pattern: TYPE_URL_PATTERN,
    description:
      "The type URL of the packed message, such as type.googleapis.com/acme.v1.Money. " +
      "It must name a message the service's .proto files define.",
  };
  return { type: "object", properties: { "@type": typeUrl }, required: ["@type"], additionalProperties: true };
}

/**
 * The pattern a request's map key must match, by the key's type, or
 * undefined for a string key. A decimal integer is the form toJson writes,
 * and the encoder checks its range.
 */
function mapKeyPattern(key: ScalarType): string | undefined {
  switch (key) {
    case ScalarType.INT32:
    case ScalarType.SINT32:
    case ScalarType.SFIXED32:
    case ScalarType.INT64:
    case ScalarType.SINT64:
    case ScalarType.SFIXED64:
      return "^-?[0-9]+$";
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return "^[0-9]+$";
    case ScalarType.BOOL:
      return "^(true|false)$";
    default:
      return undefined;
  }
}

/**
 * The JSON form of a well-known type that has its own, or undefined for a
 * message that maps field by field. google.protobuf.Empty has no fields, so
 * it maps as an ordinary message to an empty object.
 */
function wellKnownSchema(desc: DescMessage, direction: Direction): JsonSchema | undefined {
  switch (desc.typeName) {
    case "google.protobuf.Any":
      return anySchema(direction);
    case "google.protobuf.Timestamp":
      return { type: "string", format: "date-time" };
    case "google.protobuf.Duration":
      return { type: "string", pattern: "^-?[0-9]+(\\.[0-9]{1,9})?s$" };
    case "google.protobuf.FieldMask":
      return { type: "string" };
    case "google.protobuf.Struct":
      return { type: "object", additionalProperties: true };
    case "google.protobuf.Value":
      return {};
    case "google.protobuf.ListValue":
      return { type: "array", items: {} };
  }
  const [value] = desc.fields;
  if (isWrapperDesc(desc) && value?.fieldKind === "scalar") return scalarSchema(value.scalar);
  return undefined;
}

/** The schema with a field's description ahead of its type's own. */
function withDescription(schema: JsonSchema, description: string | undefined): JsonSchema {
  if (description === undefined) return schema;
  return {
    ...schema,
    description: schema.description === undefined ? description : `${description}\n\n${schema.description}`,
  };
}

/** Exactly one of the fields, or none of them. */
function oneofRule(names: readonly string[]): JsonSchema {
  const each = names.map((name) => ({ required: [name] }));
  return { oneOf: [...each, { not: { anyOf: names.map((name) => ({ required: [name] })) } }] };
}

/** Whether toJson always writes the field (output), or fromJson needs it (input). */
function isRequired(field: DescField, direction: Direction): boolean {
  if (field.presence === FeatureSet_FieldPresence.LEGACY_REQUIRED) return true;
  return direction === "output" && field.presence === FeatureSet_FieldPresence.IMPLICIT;
}

/**
 * Builds the schemas of one import. One builder serves every tool, so the
 * whole import shares one node budget. Call beginTool before each tool's
 * schemas, so the per-tool count and the notes name that tool.
 */
export class SchemaBuilder {
  private nodes = 0;
  private toolNodes = 0;
  private tool: string | undefined;
  /** How many times each message is open on the current path, to cut recursion. */
  private readonly active = new Map<string, number>();

  constructor(
    private readonly comments: ReadonlyMap<string, string>,
    private readonly notes: Notes,
  ) {}

  beginTool(tool: string): void {
    this.tool = tool;
    this.toolNodes = 0;
  }

  /**
   * A request or response message as a tool's inputSchema or outputSchema,
   * or undefined when the message's JSON form is not an object, as with a
   * Timestamp or a wrapper type.
   */
  objectSchema(desc: DescMessage, direction: Direction): ObjectSchema | undefined {
    const schema = this.messageSchema(desc, direction, 0);
    return schema.type === "object" ? (schema as ObjectSchema) : undefined;
  }

  /** The whole JSON form of a message. The description is the message's leading comment. */
  messageSchema(desc: DescMessage, direction: Direction, depth: number): JsonSchema {
    this.spend();
    const known = wellKnownSchema(desc, direction);
    if (known !== undefined) return known;
    const name = desc.typeName;
    if (depth > DEPTH_MAX) {
      this.note(`Messages nest past ${DEPTH_MAX} levels, so import cut ${name} to a stub at that depth.`);
      return { type: "object", description: `Cut: messages nest past ${DEPTH_MAX} levels here.` };
    }
    const open = this.active.get(name) ?? 0;
    if (open >= RECURSION_DEPTH) {
      this.note(`Import cut the recursive message ${name} at depth ${RECURSION_DEPTH}.`);
      return { type: "object", description: `Cut at depth ${RECURSION_DEPTH}: ${name} refers to itself.` };
    }
    if (this.toolNodes > TOOL_NODES_SOFT_MAX) {
      this.note(
        `This tool's schemas passed ${count(TOOL_NODES_SOFT_MAX)} nodes, so import cut each message after that point to a stub.`,
      );
      return { type: "object", description: `Cut: this tool's schemas passed ${count(TOOL_NODES_SOFT_MAX)} nodes.` };
    }
    this.active.set(name, open + 1);
    try {
      return this.fieldsOf(desc, direction, depth);
    } finally {
      if (open === 0) this.active.delete(name);
      else this.active.set(name, open);
    }
  }

  private fieldsOf(desc: DescMessage, direction: Direction, depth: number): JsonSchema {
    const properties = Object.fromEntries(
      desc.fields.map((field) => [field.jsonName, this.fieldSchema(field, direction, depth + 1)]),
    );
    const schema: JsonSchema = { type: "object" };
    const description = this.comments.get(desc.typeName);
    if (description !== undefined) schema.description = description;
    schema.properties = properties;
    const required = desc.fields.filter((field) => isRequired(field, direction)).map((field) => field.jsonName);
    if (required.length > 0) schema.required = required;
    if (direction === "input") schema.additionalProperties = false;
    const rules = desc.oneofs.map((oneof) => oneofRule(oneof.fields.map((field) => field.jsonName)));
    const [only] = rules;
    if (rules.length === 1 && only !== undefined) schema.oneOf = only.oneOf;
    else if (rules.length > 1) schema.allOf = rules;
    return schema;
  }

  private fieldSchema(field: DescField, direction: Direction, depth: number): JsonSchema {
    this.spend();
    let schema = this.kindSchema(field, direction, depth);
    if (field.deprecated) schema = { ...schema, deprecated: true };
    return withDescription(schema, this.comments.get(`${field.parent.typeName}.${field.name}`));
  }

  private kindSchema(field: DescField, direction: Direction, depth: number): JsonSchema {
    switch (field.fieldKind) {
      case "list":
        return { type: "array", items: this.valueSchema(field, direction, depth) };
      case "map": {
        const value = this.valueSchema(field, direction, depth);
        const key = direction === "input" ? mapKeyPattern(field.mapKey) : undefined;
        if (key === undefined) return { type: "object", additionalProperties: value };
        // validate.ts checks patternProperties but not propertyNames, so this is the form that refuses a bad key.
        return { type: "object", patternProperties: { [key]: value }, additionalProperties: false };
      }
      default:
        return this.valueSchema(field, direction, depth);
    }
  }

  /** A single field's value, a list's item, or a map's value. */
  private valueSchema(field: DescField, direction: Direction, depth: number): JsonSchema {
    if (field.enum !== undefined) return this.enumSchema(field.enum, direction);
    if (field.message !== undefined) return this.messageSchema(field.message, direction, depth);
    return scalarSchema(field.scalar ?? ScalarType.STRING);
  }

  /** An enum by its value names, with the enum's comment and each value's. */
  private enumSchema(desc: DescEnum, direction: Direction): JsonSchema {
    this.spend();
    if (desc.typeName === "google.protobuf.NullValue") return { type: "null" };
    const names: JsonSchema = { type: "string", enum: desc.values.map((value) => value.name) };
    const described = desc.values.flatMap((value) => {
      const text = this.comments.get(`${desc.typeName}.${value.name}`);
      return text === undefined ? [] : [`${value.name}: ${text}`];
    });
    const parts = [this.comments.get(desc.typeName), described.length > 0 ? described.join("\n") : undefined];
    const description = parts.filter((part) => part !== undefined).join("\n\n");
    const schema: JsonSchema =
      direction === "output" && desc.open
        ? { anyOf: [names, { type: "integer", description: "A value this definition does not name." }] }
        : names;
    return description === "" ? schema : { description, ...schema };
  }

  private spend(): void {
    this.nodes += 1;
    this.toolNodes += 1;
    if (this.nodes > EXPANSION_NODES_MAX) {
      throw new GrpcImportError(
        "expansion_limit",
        `Schema expansion passed ${count(EXPANSION_NODES_MAX)} nodes, the limit for one import. ` +
          "Remove unused services or split the definition, then import again.",
      );
    }
  }

  private note(message: string): void {
    this.notes.add(this.tool, message);
  }
}
