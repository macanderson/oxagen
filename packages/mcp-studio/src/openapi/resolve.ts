// resolve.ts: every local $ref of the upgraded document, followed.
//
// A parameter, a request body, a response, a path item, or a security
// scheme is followed through its $ref chain. A schema is expanded into a
// copy with no $ref left, because a tool's inputSchema and outputSchema
// stand alone. Keywords beside a schema's $ref hold in addition to its
// target, so neither replaces the other's constraints. Four guards keep a
// stranger's document from running away:
//
// - A schema that refers to itself is expanded RECURSION_DEPTH times, then
//   cut to a stub with a note.
// - A chain of $refs with no schema between them is refused as ref_cycle.
// - Every node counts against EXPANSION_NODES_MAX for the whole import.
//   Past TOOL_NODES_SOFT_MAX in one tool, each further $ref becomes a stub.
// - A schema nested deeper than DEPTH_MAX is refused.
import type { ImportNote } from "../model/import-result";
import { OpenApiImportError, count } from "./errors";
import {
  NodeBudget,
  copyJson,
  deepEqual,
  depthError,
  isList,
  isRecord,
  pointerTokens,
  setOwn,
  valueAt,
  type JsonRecord,
} from "./json";
import { DEPTH_MAX, EXPANSION_NODES_MAX, RECURSION_DEPTH, TOOL_NODES_SOFT_MAX } from "./limits";

/** Which side of a call a schema describes. Input drops readOnly properties, and output drops writeOnly ones. */
export type Direction = "input" | "output";

/** Keys a tool's schema never carries: examples, XML hints, and keywords that only make sense beside a $ref. */
const STRIP = new Set([
  "discriminator",
  "xml",
  "externalDocs",
  "example",
  "examples",
  "nullable",
  "$comment",
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveRef",
  "$recursiveAnchor",
  "$defs",
  "definitions",
  "$vocabulary",
]);

/** Keys whose value maps a name to a schema. */
const MAP_KEYS = new Set(["properties", "patternProperties", "dependentSchemas"]);

/** Keys whose value is a list of schemas. */
const LIST_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Keys whose value is one schema. `items` may also be a list, as older drafts wrote a tuple. */
const ONE_KEYS = new Set([
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "additionalItems",
  "contentSchema",
]);

/** A NodeBudget that also counts the nodes of the tool import is building now. */
class ExpansionBudget extends NodeBudget {
  toolNodes = 0;

  override spend(): void {
    super.spend();
    this.toolNodes += 1;
  }
}

function withoutRef(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "$ref"));
}

/**
 * Keywords that describe a schema and constrain nothing. Beside a $ref, the
 * author wrote one to describe this use of the target, so it replaces the
 * target's own.
 */
const ANNOTATIONS = new Set([
  "title",
  "description",
  "deprecated",
  "default",
  "examples",
  "example",
  "readOnly",
  "writeOnly",
  "$comment",
  "externalDocs",
  "xml",
  "discriminator",
]);

/** Keywords that make an object refuse a property its `properties` does not name. */
const CLOSED_KEYS = ["additionalProperties", "patternProperties", "unevaluatedProperties"] as const;

function isAnnotation(key: string): boolean {
  return ANNOTATIONS.has(key) || key.startsWith("x-");
}

function closes(schema: JsonRecord): boolean {
  return CLOSED_KEYS.some((key) => schema[key] !== undefined);
}

/** True when both are absent, or both are records with the same names. */
function sameNames(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (!isRecord(a) || !isRecord(b)) return false;
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => Object.hasOwn(b, name));
}

/**
 * True when merging the two schemas' properties into one object would change
 * which properties it accepts. A side that refuses unnamed properties refuses
 * them against its own `properties` only, so its list cannot grow.
 */
function closedMismatch(target: JsonRecord, siblings: JsonRecord): boolean {
  const opens = (closed: JsonRecord, other: JsonRecord): boolean =>
    closes(closed) && other.properties !== undefined && !sameNames(closed.properties, other.properties);
  return opens(target, siblings) || opens(siblings, target);
}

function mergeProperties(inner: JsonRecord, outer: JsonRecord): JsonRecord {
  const properties: JsonRecord = { ...inner };
  for (const [name, schema] of Object.entries(outer)) {
    if (!Object.hasOwn(properties, name)) setOwn(properties, name, schema);
    else if (!deepEqual(properties[name], schema)) setOwn(properties, name, { allOf: [properties[name], schema] });
  }
  return properties;
}

/**
 * A $ref's target and the keywords beside it, as one schema that holds both.
 * OpenAPI 3.1 applies keywords beside a $ref in addition to the target, so
 * neither replaces the other: the required lists join, the properties merge,
 * and annotations such as description come from beside the $ref. When both
 * set any other keyword differently, the result is an allOf of the two, which
 * keeps every constraint exactly.
 */
function conjoin(target: JsonRecord, siblings: JsonRecord): JsonRecord {
  if (closedMismatch(target, siblings)) return allOfBoth(target, siblings);
  const merged: JsonRecord = { ...target };
  for (const [key, value] of Object.entries(siblings)) {
    const before = merged[key];
    if (!Object.hasOwn(merged, key) || isAnnotation(key)) setOwn(merged, key, value);
    else if (deepEqual(before, value)) continue;
    else if (key === "required" && isList(before) && isList(value)) {
      merged.required = [...before, ...value.filter((name) => !before.includes(name))];
    } else if (key === "properties" && isRecord(before) && isRecord(value)) {
      merged.properties = mergeProperties(before, value);
    } else {
      return allOfBoth(target, siblings);
    }
  }
  return merged;
}

/** The target and the constraints beside its $ref as an allOf, with the annotations kept outside it. */
function allOfBoth(target: JsonRecord, siblings: JsonRecord): JsonRecord {
  const annotations = Object.entries(siblings).filter(([key]) => isAnnotation(key));
  const constraints = Object.fromEntries(Object.entries(siblings).filter(([key]) => !isAnnotation(key)));
  return { ...Object.fromEntries(annotations), allOf: [target, constraints] };
}

function refName(ref: string): string {
  const tokens = pointerTokens(decodeURIComponent(ref.slice(1)));
  return tokens[tokens.length - 1] ?? "the document";
}

function stubType(target: JsonRecord): unknown {
  const { type } = target;
  if (typeof type === "string") return type;
  if (isList(type) && type.every((item) => typeof item === "string")) return [...type];
  return undefined;
}

const PARENT_KEYS = new Set(["allOf", "type", "properties", "required", "description", "title"]);
const PART_KEYS = new Set(["type", "properties", "required", "description", "title"]);

/**
 * An allOf of plain objects, merged into one object. Many documents build a
 * schema as allOf a base and an extension, and a model reads one object
 * better than a composition. Any keyword the merge cannot carry leaves the
 * allOf as it is. A property two parts define differently becomes an allOf
 * of both.
 */
export function flattenAllOf(schema: JsonRecord): JsonRecord {
  const parts = schema.allOf;
  if (!isList(parts) || parts.length === 0) return schema;
  if (!Object.keys(schema).every((key) => PARENT_KEYS.has(key))) return schema;
  const records: JsonRecord[] = [];
  for (const part of parts) {
    if (!isRecord(part) || !Object.keys(part).every((key) => PART_KEYS.has(key))) return schema;
    records.push(part);
  }
  const all = [...records, schema];
  if (!all.every((item) => item.type === undefined || item.type === "object")) return schema;
  const objectLike = all.some((item) => item.type === "object") || records.every((item) => isRecord(item.properties));
  if (!objectLike) return schema;

  const properties: JsonRecord = {};
  const required: string[] = [];
  for (const item of all) {
    if (isRecord(item.properties)) {
      for (const [name, property] of Object.entries(item.properties)) {
        if (!Object.hasOwn(properties, name)) setOwn(properties, name, property);
        else if (!deepEqual(properties[name], property)) setOwn(properties, name, { allOf: [properties[name], property] });
      }
    }
    if (isList(item.required)) {
      for (const name of item.required) {
        if (typeof name === "string" && !required.includes(name)) required.push(name);
      }
    }
  }
  const flat: JsonRecord = { type: "object" };
  if (schema.title !== undefined) flat.title = schema.title;
  if (schema.description !== undefined) flat.description = schema.description;
  if (Object.keys(properties).length > 0) flat.properties = properties;
  if (required.length > 0) flat.required = required;
  return flat;
}

export class Resolver {
  private readonly budget = new ExpansionBudget(EXPANSION_NODES_MAX, "Schema expansion");
  private tool: string | undefined;
  /** How many times each schema is open on the current path. */
  private readonly active = new Map<string, number>();
  /** Notes already written for the current tool, so each says its thing once. */
  private readonly noted = new Set<string>();

  constructor(
    private readonly document: JsonRecord,
    private readonly notes: ImportNote[],
  ) {}

  /** Starts a tool: its node count, and the notes it has written, start over. */
  beginTool(name: string | undefined): void {
    this.tool = name;
    this.budget.toolNodes = 0;
    this.active.clear();
    this.noted.clear();
  }

  private noteOnce(key: string, message: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.notes.push({ tool: this.tool, message });
  }

  /** The value a local $ref points at. */
  private target(ref: string): unknown {
    if (!ref.startsWith("#")) {
      throw new OpenApiImportError(
        "ref_missing",
        `The $ref "${ref}" names another file after the bundle, so an overlay may have added it. ` +
          "Point the $ref inside the document and import again.",
        { ref },
      );
    }
    let fragment: string;
    try {
      fragment = decodeURIComponent(ref.slice(1));
    } catch {
      throw new OpenApiImportError(
        "ref_missing",
        `The $ref "${ref}" has a fragment that is not valid. Fix the $ref and import again.`,
        { ref },
      );
    }
    if (fragment !== "" && !fragment.startsWith("/")) {
      throw new OpenApiImportError(
        "ref_missing",
        `The $ref "${ref}" uses an anchor. Import follows JSON Pointer fragments only, such as #/components/schemas/Pet.`,
        { ref },
      );
    }
    const found = valueAt(this.document, pointerTokens(fragment));
    if (!found.found) {
      throw new OpenApiImportError(
        "ref_missing",
        `The $ref "${ref}" names a location the document does not have. Fix the $ref and import again.`,
        { ref },
      );
    }
    return found.value;
  }

  /**
   * Follows a $ref chain to the value at its end. `hops` holds each $ref's
   * other keys, outermost first.
   */
  private follow(value: unknown): { value: unknown; ref: string | undefined; hops: JsonRecord[] } {
    let current = value;
    const hops: JsonRecord[] = [];
    let ref: string | undefined;
    const seen = new Set<string>();
    while (isRecord(current) && typeof current.$ref === "string") {
      ref = current.$ref;
      if (seen.has(ref)) {
        throw new OpenApiImportError(
          "ref_cycle",
          `The $ref "${ref}" leads back to itself through $ref alone, with no schema between. ` +
            "Point one of the $refs at a schema and import again.",
          { ref },
        );
      }
      seen.add(ref);
      const siblings = withoutRef(current);
      if (Object.keys(siblings).length > 0) hops.push(siblings);
      current = this.target(ref);
    }
    return { value: current, ref, hops };
  }

  /**
   * A parameter, request body, response, path item, or security scheme, with
   * its $ref chain followed. A Reference Object's summary and description
   * replace the target's, and the outermost wins.
   */
  resolveObject(value: unknown): unknown {
    const followed = this.follow(value);
    const target = followed.value;
    if (followed.hops.length === 0 || !isRecord(target)) return target;
    return followed.hops.reduceRight<JsonRecord>((merged, siblings) => ({ ...merged, ...siblings }), target);
  }

  /** A schema as a copy with no $ref left, for one side of a call. */
  schema(value: unknown, direction: Direction): unknown {
    return this.expand(value, direction, 0);
  }

  private expand(value: unknown, direction: Direction, depth: number): unknown {
    if (depth > DEPTH_MAX) throw depthError("A schema");
    if (!isRecord(value)) return copyJson(value, this.budget, "A schema", depth);
    this.budget.spend();
    if (typeof value.$ref === "string") return this.expandRef(value, direction, depth);
    return this.expandPlain(value, direction, depth);
  }

  private expandRef(record: JsonRecord, direction: Direction, depth: number): unknown {
    const followed = this.follow(record);
    const ref = followed.ref as string;
    const target = followed.value;
    // Each hop's keys hold in addition to everything inside it, so the fold
    // runs from the innermost hop out, and the outermost annotation wins.
    const inside = (start: JsonRecord): JsonRecord =>
      followed.hops.reduceRight((schema, siblings) => conjoin(schema, siblings), start);
    if (target === true) return this.expandPlain(inside({}), direction, depth);
    if (target === false) return { not: {} };
    if (!isRecord(target)) {
      this.noteOnce(`not-schema:${ref}`, `The $ref "${ref}" does not point at a schema, so import read it as any value.`);
      return {};
    }
    const name = refName(ref);
    const open = this.active.get(ref) ?? 0;
    if (open >= RECURSION_DEPTH) {
      this.noteOnce(`recursive:${ref}`, `Import cut the recursive schema ${name} at depth ${RECURSION_DEPTH}.`);
      return this.stub(target, `Cut at depth ${RECURSION_DEPTH}: ${name} refers to itself.`);
    }
    if (this.budget.toolNodes > TOOL_NODES_SOFT_MAX) {
      this.noteOnce(
        "size",
        `This tool's schemas passed ${count(TOOL_NODES_SOFT_MAX)} nodes, so import cut each $ref after that point to a stub.`,
      );
      return this.stub(target, `Cut: this tool's schemas passed ${count(TOOL_NODES_SOFT_MAX)} nodes.`);
    }
    this.active.set(ref, open + 1);
    try {
      return this.expandPlain(inside(target), direction, depth);
    } finally {
      if (open === 0) this.active.delete(ref);
      else this.active.set(ref, open);
    }
  }

  private stub(target: JsonRecord, description: string): JsonRecord {
    const type = stubType(target);
    return type === undefined ? { description } : { type, description };
  }

  /** True when a property's schema, through its $ref chain, sets `flag` to true. It never throws. */
  private hasFlag(value: unknown, flag: "readOnly" | "writeOnly"): boolean {
    let current = value;
    for (let hops = 0; hops < 64 && isRecord(current); hops += 1) {
      if (current[flag] === true) return true;
      if (typeof current.$ref !== "string") return false;
      try {
        current = this.target(current.$ref);
      } catch {
        return false;
      }
    }
    return false;
  }

  private expandPlain(record: JsonRecord, direction: Direction, depth: number): JsonRecord {
    const entries: [string, unknown][] = [];
    const dropped = new Set<string>();
    const next = depth + 1;
    for (const [key, value] of Object.entries(record)) {
      if (key === "$ref" || STRIP.has(key) || key.startsWith("x-")) continue;
      if (MAP_KEYS.has(key) && isRecord(value)) {
        const flag = direction === "input" ? "readOnly" : "writeOnly";
        const kept = Object.entries(value).filter(([name, schema]) => {
          if (key !== "properties" || !this.hasFlag(schema, flag)) return true;
          dropped.add(name);
          return false;
        });
        entries.push([key, Object.fromEntries(kept.map(([name, schema]) => [name, this.expand(schema, direction, next + 1)]))]);
      } else if (LIST_KEYS.has(key) && isList(value)) {
        entries.push([key, value.map((item) => this.expand(item, direction, next))]);
      } else if (ONE_KEYS.has(key) && (isRecord(value) || typeof value === "boolean")) {
        entries.push([key, this.expand(value, direction, next)]);
      } else if (key === "items" && isList(value)) {
        entries.push([key, value.map((item) => this.expand(item, direction, next))]);
      } else {
        entries.push([key, copyJson(value, this.budget, "A schema", next)]);
      }
    }
    const expanded = Object.fromEntries(entries);
    if (dropped.size > 0 && isList(expanded.required)) {
      const required = expanded.required.filter((name) => typeof name !== "string" || !dropped.has(name));
      if (required.length > 0) expanded.required = required;
      else delete expanded.required;
    }
    return flattenAllOf(expanded);
  }
}
