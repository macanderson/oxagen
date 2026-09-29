// validate.ts: check a call's arguments against the effective inputSchema
// (mcp-studio-spec, Call path, Validate).
//
// The executor validates before it shapes the input, so a model that sends a
// bad argument gets an isError result that names the argument and the rule,
// and can correct the call. Each issue is one sentence about the input, such
// as "input.amount must be at least 1."
//
// The checker covers the JSON Schema keywords an imported inputSchema uses:
// type, enum, const, the string, number, array, and object bounds, the
// combinators, if/then/else, and local $ref. A keyword it does not know
// passes, as does a $ref it cannot resolve and a pattern that is not a valid
// regular expression, so a schema it cannot read never refuses a call the
// upstream would take. Nesting deeper than 64 levels passes for the same
// reason, and it also bounds a recursive $ref.
import { isList, isRecord, jsonEqual } from "./util";

/** The deepest nesting checked. Anything deeper passes. */
const MAX_DEPTH = 64;

/**
 * The most schema nodes one validation visits. A schema whose combinators
 * nest through a recursive $ref can branch at every level, so the budget
 * bounds the work, and the nodes past it pass.
 */
const MAX_STEPS = 100_000;

/** The most issues one call reports. */
export const MAX_ISSUES = 10;

type Schema = Record<string, unknown>;

/** Every way the arguments break the schema, as sentences. Empty when they conform. */
export function validateInput(schema: unknown, value: unknown): string[] {
  return new Checker(schema).check(schema, value, "input", 0).slice(0, MAX_ISSUES);
}

/**
 * The isError text for arguments the input schema refuses, or null when they
 * conform. Two callers ask this question: the executor, before it shapes the
 * input, and a served call, before it claims its approval. They share the
 * builder so the sentence an agent reads is the same from either path.
 */
export function inputRefusal(schema: unknown, value: unknown): string | null {
  const issues = validateInput(schema, value);
  if (issues.length === 0) return null;
  return `The arguments do not match the tool's input schema. ${issues.join(" ")}`;
}

const TYPE_NAMES: Record<string, string> = {
  string: "a string",
  number: "a number",
  integer: "an integer",
  boolean: "a boolean",
  object: "an object",
  array: "an array",
  null: "null",
};

class Checker {
  private readonly root: unknown;
  private steps = 0;

  constructor(root: unknown) {
    this.root = root;
  }

  check(schema: unknown, value: unknown, path: string, depth: number): string[] {
    this.steps += 1;
    if (depth > MAX_DEPTH || this.steps > MAX_STEPS) return [];
    if (schema === false) return [`${path} is not allowed.`];
    if (!isRecord(schema)) return [];
    // OpenAPI 3.0 writes a nullable value this way.
    if (value === null && schema.nullable === true) return [];

    const issues: string[] = [];
    if (typeof schema.$ref === "string") {
      const target = resolveRef(this.root, schema.$ref);
      if (target !== undefined) issues.push(...this.check(target, value, path, depth + 1));
    }

    const typeIssue = checkType(schema, value, path);
    if (typeIssue !== undefined) return [...issues, typeIssue];

    if (isList(schema.enum) && !schema.enum.some((option) => jsonEqual(option, value))) {
      issues.push(`${path} must be one of ${listOf(schema.enum)}.`);
    }
    if (Object.hasOwn(schema, "const") && !jsonEqual(schema.const, value)) {
      issues.push(`${path} must be ${JSON.stringify(schema.const)}.`);
    }

    if (typeof value === "string") issues.push(...checkString(schema, value, path));
    else if (typeof value === "number") issues.push(...checkNumber(schema, value, path));
    else if (isList(value)) issues.push(...this.checkArray(schema, value, path, depth));
    else if (isRecord(value)) issues.push(...this.checkObject(schema, value, path, depth));

    issues.push(...this.checkCombinators(schema, value, path, depth));
    return issues;
  }

  private matches(schema: unknown, value: unknown, path: string, depth: number): boolean {
    return this.check(schema, value, path, depth).length === 0;
  }

  private checkArray(schema: Schema, value: unknown[], path: string, depth: number): string[] {
    const issues: string[] = [];
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push(`${path} must have at least ${schema.minItems} ${plural(schema.minItems, "item")}.`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issues.push(`${path} must have at most ${schema.maxItems} ${plural(schema.maxItems, "item")}.`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set<string>();
      const repeat = value.findIndex((item) => {
        const key = canonical(item);
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      });
      if (repeat !== -1) issues.push(`${path}[${repeat}] repeats an earlier item, and ${path} must have unique items.`);
    }

    // prefixItems (2020-12), or items as an array (draft 4 to 2019-09), fixes each leading item's schema.
    const tuple = isList(schema.prefixItems) ? schema.prefixItems : isList(schema.items) ? schema.items : [];
    const rest = isList(schema.prefixItems)
      ? schema.items
      : isList(schema.items)
        ? schema.additionalItems
        : schema.items;
    value.forEach((item, index) => {
      const itemSchema = index < tuple.length ? tuple[index] : rest;
      if (itemSchema !== undefined) issues.push(...this.check(itemSchema, item, `${path}[${index}]`, depth + 1));
    });

    if (schema.contains !== undefined && !value.some((item) => this.matches(schema.contains, item, path, depth + 1))) {
      issues.push(`${path} must contain an item that matches its contains schema.`);
    }
    return issues;
  }

  private checkObject(schema: Schema, value: Record<string, unknown>, path: string, depth: number): string[] {
    const issues: string[] = [];
    const present = Object.keys(value).filter((key) => value[key] !== undefined);
    if (isList(schema.required)) {
      for (const name of schema.required) {
        if (typeof name === "string" && !present.includes(name)) issues.push(`${propertyPath(path, name)} is required.`);
      }
    }
    if (typeof schema.minProperties === "number" && present.length < schema.minProperties) {
      issues.push(`${path} must have at least ${schema.minProperties} ${plural(schema.minProperties, "property", "properties")}.`);
    }
    if (typeof schema.maxProperties === "number" && present.length > schema.maxProperties) {
      issues.push(`${path} must have at most ${schema.maxProperties} ${plural(schema.maxProperties, "property", "properties")}.`);
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    const patterns = isRecord(schema.patternProperties) ? Object.entries(schema.patternProperties) : [];
    for (const key of present) {
      const at = propertyPath(path, key);
      let known = false;
      if (Object.hasOwn(properties, key)) {
        known = true;
        issues.push(...this.check(properties[key], value[key], at, depth + 1));
      }
      for (const [pattern, patternSchema] of patterns) {
        if (testPattern(pattern, key) === true) {
          known = true;
          issues.push(...this.check(patternSchema, value[key], at, depth + 1));
        }
      }
      if (known || schema.additionalProperties === undefined) continue;
      if (schema.additionalProperties === false) issues.push(`${at} is not an allowed property.`);
      else issues.push(...this.check(schema.additionalProperties, value[key], at, depth + 1));
    }
    return issues;
  }

  private checkCombinators(schema: Schema, value: unknown, path: string, depth: number): string[] {
    const issues: string[] = [];
    if (isList(schema.allOf)) {
      for (const part of schema.allOf) issues.push(...this.check(part, value, path, depth + 1));
    }
    if (isList(schema.anyOf) && !schema.anyOf.some((part) => this.matches(part, value, path, depth + 1))) {
      issues.push(`${path} must match at least one of its anyOf schemas.`);
    }
    if (isList(schema.oneOf)) {
      const count = schema.oneOf.filter((part) => this.matches(part, value, path, depth + 1)).length;
      if (count !== 1) issues.push(`${path} must match exactly one of its oneOf schemas, and it matches ${count}.`);
    }
    if (schema.not !== undefined && this.matches(schema.not, value, path, depth + 1)) {
      issues.push(`${path} must not match its not schema.`);
    }
    if (schema.if !== undefined) {
      const branch = this.matches(schema.if, value, path, depth + 1) ? schema.then : schema.else;
      if (branch !== undefined) issues.push(...this.check(branch, value, path, depth + 1));
    }
    return issues;
  }
}

/** The issue when value has none of the schema's types, or undefined when it has one or the schema names none. */
function checkType(schema: Schema, value: unknown, path: string): string | undefined {
  const types = typeof schema.type === "string" ? [schema.type] : isList(schema.type) ? schema.type : [];
  const known = types.filter((type): type is string => typeof type === "string" && Object.hasOwn(TYPE_NAMES, type));
  if (known.length === 0 || known.some((type) => hasType(type, value))) return undefined;
  return `${path} must be ${known.map((type) => TYPE_NAMES[type]).join(" or ")}.`;
}

function hasType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isRecord(value);
    case "array":
      return isList(value);
    default:
      return value === null;
  }
}

function checkString(schema: Schema, value: string, path: string): string[] {
  const issues: string[] = [];
  // JSON Schema counts characters as code points, not UTF-16 units.
  const length = [...value].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    issues.push(`${path} must be at least ${schema.minLength} ${plural(schema.minLength, "character")} long.`);
  }
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    issues.push(`${path} must be at most ${schema.maxLength} ${plural(schema.maxLength, "character")} long.`);
  }
  if (typeof schema.pattern === "string" && testPattern(schema.pattern, value) === false) {
    issues.push(`${path} must match the pattern ${schema.pattern}.`);
  }
  return issues;
}

function checkNumber(schema: Schema, value: number, path: string): string[] {
  const issues: string[] = [];
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = schema;
  if (typeof minimum === "number") {
    // Draft 4 and OpenAPI 3.0 write exclusiveMinimum as a flag on minimum.
    if (exclusiveMinimum === true) {
      if (value <= minimum) issues.push(`${path} must be greater than ${minimum}.`);
    } else if (value < minimum) issues.push(`${path} must be at least ${minimum}.`);
  }
  if (typeof maximum === "number") {
    if (exclusiveMaximum === true) {
      if (value >= maximum) issues.push(`${path} must be less than ${maximum}.`);
    } else if (value > maximum) issues.push(`${path} must be at most ${maximum}.`);
  }
  if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
    issues.push(`${path} must be greater than ${exclusiveMinimum}.`);
  }
  if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
    issues.push(`${path} must be less than ${exclusiveMaximum}.`);
  }
  if (typeof multipleOf === "number" && multipleOf > 0) {
    const quotient = value / multipleOf;
    // A decimal step such as 0.01 leaves a rounding error in the quotient.
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) issues.push(`${path} must be a multiple of ${multipleOf}.`);
  }
  return issues;
}

/** True or false when the pattern matches, or undefined when it is not a valid regular expression. */
function testPattern(pattern: string, value: string): boolean | undefined {
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return undefined;
    }
  }
}

/** A local $ref: #, or a JSON pointer such as #/$defs/money. Anything else resolves to undefined. */
export function resolveRef(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current = root;
  for (const raw of ref.slice(2).split("/")) {
    let token: string;
    try {
      token = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    } catch {
      return undefined;
    }
    if (isList(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

/** JSON text with object keys sorted, so two equal values give the same text. */
function canonical(value: unknown): string {
  if (isList(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function propertyPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Up to 10 values in JSON, and a count of the rest. */
function listOf(values: unknown[]): string {
  const shown = values.slice(0, 10).map((value) => JSON.stringify(value) ?? String(value));
  const more = values.length - shown.length;
  return more > 0 ? `${shown.join(", ")}, and ${more} more` : shown.join(", ");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}
