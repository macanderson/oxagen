// schema.ts: the JSON Schema and GraphQL reads the tool checks share.
//
// A schema here is whatever the source sent, so each read checks the shape it
// needs and treats anything else as absent.
import { isRecord, propertiesOf } from "../compile/json-schema";

/** Keywords whose value maps names to schemas. */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
/** Keywords whose value is data, never a schema. */
const DATA = new Set(["enum", "const", "default", "examples", "example"]);
/** Import cuts recursion at depth 4, so a real schema never comes near this. */
const MAX_DEPTH = 64;

/** Called once per schema node with its path, such as inputSchema.properties.reason. */
export type SchemaVisit = (node: Record<string, unknown>, at: string) => void;

/**
 * Visits every schema node under root, root first. A node that holds itself is
 * visited once on each path down to the cycle, and the walk stops at depth 64.
 */
export function walkSchemas(root: unknown, at: string, visit: SchemaVisit): void {
  const above = new Set<object>();
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isRecord(node) || above.has(node)) return;
    visit(node, path);
    above.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (DATA.has(key)) continue;
      if (SCHEMA_MAPS.has(key) && isRecord(value)) {
        for (const [name, child] of Object.entries(value)) walk(child, `${path}.${key}.${name}`, depth + 1);
      } else {
        walk(value, `${path}.${key}`, depth + 1);
      }
    }
    above.delete(node);
  };
  walk(root, at, 0);
}

/** The one value a property schema allows, as JSON, or undefined. */
function tagOf(schema: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length === 1) return JSON.stringify(schema.enum[0]);
  return undefined;
}

/**
 * True when a model can tell oneOf's branches apart without a discriminator:
 * each branch has its own type, or one property holds a different single
 * value in every branch.
 */
export function distinguishable(branches: readonly unknown[]): boolean {
  if (branches.length < 2) return true;
  const records = branches.filter(isRecord);
  const [first] = records;
  if (first === undefined || records.length < branches.length) return false;
  const types = records.map((branch) => branch.type);
  if (types.every((type) => typeof type === "string") && new Set(types).size === records.length) return true;
  return Object.keys(propertiesOf(first)).some((name) => {
    const tags = records.map((branch) => tagOf(propertiesOf(branch)[name]));
    return tags.every((tag) => tag !== undefined) && new Set(tags).size === records.length;
  });
}

/** A GraphQL string, a spread, a name, or a punctuator the depth count reads. */
const SELECTION_TOKEN = /"(?:[^"\\]|\\.)*"|\.\.\.|[_A-Za-z][_0-9A-Za-z]*|[{}()@]/g;

/**
 * How many field levels a selection set nests: `{ id }` is 1, and
 * `{ issue { id } }` is 2. An inline fragment adds no level, and arguments,
 * strings, and directives are skipped.
 */
export function selectionDepth(selection: string): number {
  const levels: number[] = [];
  let parens = 0;
  let directive = false;
  /** After `...`: a spread, then `on`, then the type condition, then an inline fragment's `{`. */
  let fragment: "none" | "spread" | "on" | "inline" = "none";
  let deepest = 0;
  for (const token of selection.match(SELECTION_TOKEN) ?? []) {
    if (token === "(") parens += 1;
    else if (token === ")") parens = Math.max(0, parens - 1);
    else if (parens > 0 || token.startsWith('"')) continue;
    else if (token === "@") directive = true;
    else if (directive) directive = false;
    else if (token === "...") fragment = "spread";
    else if (token === "{") {
      const parent = levels.at(-1) ?? 0;
      const level = fragment === "spread" || fragment === "inline" ? parent : parent + 1;
      levels.push(level);
      deepest = Math.max(deepest, level);
      fragment = "none";
    } else if (token === "}") levels.pop();
    else if (fragment === "spread") fragment = token === "on" ? "on" : "none";
    else if (fragment === "on") fragment = "inline";
    else fragment = "none";
  }
  return deepest;
}
