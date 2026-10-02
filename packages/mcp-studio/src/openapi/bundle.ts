// bundle.ts: a document split across files, as one document.
//
// The walk starts at the entry and copies it. For OpenAPI 3.x, each value
// another file holds is copied once, the first time a $ref names it, to
// components["x-oxagen-bundled"], and every $ref to it, the first included,
// points there. An overlay applies after the bundle, so an action that edits
// or removes one $ref site must not change what another site reads: no site
// holds a copy another site points into. A $ref keeps the keys beside it, and
// the resolver applies them to the target. A cycle across files ends at the
// bundled copy, because the copy's place is known before its walk starts. A
// $ref into the entry becomes a local `#/` ref. Import never reads a disk or
// fetches a URL: ref-path.ts resolves every ref against the files it was given.
//
// A Swagger 2.0 document is converted after the bundle, and the converter
// moves values: a body parameter becomes a requestBody, and a response's
// schema moves under content. A local $ref into a moved value would point at
// nothing. So for 2.0 the bundle copies a value again at each $ref, and
// writes a local $ref only to close a cycle, where the target is a schema the
// converter leaves in place.
import { stringify as stringifyYaml } from "yaml";
import { OpenApiImportError } from "./errors";
import { NodeBudget, copyJson, depthError, isRecord, pointerFragment, valueAt, type JsonRecord } from "./json";
import { DEPTH_MAX, PARSED_NODES_MAX } from "./limits";
import { parseFile } from "./load";
import { resolveRefPath } from "./ref-path";

/**
 * Keys whose value is a map from a name the author chose to a value, such
 * as `properties` or `components.schemas`. Inside one, a key named `$ref`,
 * `default`, or `x-foo` is a name and not a keyword.
 */
const NAME_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "schemas",
  "responses",
  "parameters",
  "requestBodies",
  "headers",
  "examples",
  "securitySchemes",
  "links",
  "callbacks",
  "pathItems",
  "content",
  "encoding",
  "mapping",
  "variables",
  "webhooks",
  "paths",
  "scopes",
  "securityDefinitions",
]);

/** Keys whose value is data, where a `$ref` key is a value and never a reference. */
const DATA_KEYS = new Set(["example", "enum", "const", "default", "value"]);

/** True when `key` of a record that is not a name map holds data. */
export function isDataKey(key: string, value: unknown): boolean {
  if (key.startsWith("x-")) return true;
  if (DATA_KEYS.has(key)) return true;
  return key === "examples" && Array.isArray(value);
}

/** True when `key`'s value is a name map, given that its parent is not one. */
export function isNameMapKey(key: string, value: unknown): boolean {
  return NAME_MAP_KEYS.has(key) && isRecord(value);
}

/** Parses each file once, on first use, against one node budget. */
export class ParsedFiles {
  private readonly cache = new Map<string, unknown>();
  private readonly budget = new NodeBudget(PARSED_NODES_MAX, "The parsed document");

  constructor(private readonly texts: ReadonlyMap<string, string>) {}

  get paths(): ReadonlySet<string> {
    return new Set(this.texts.keys());
  }

  get(path: string): unknown {
    if (this.cache.has(path)) return this.cache.get(path);
    const text = this.texts.get(path);
    if (text === undefined) throw new TypeError(`no file ${path}`);
    const parsed = parseFile(text, path, this.budget);
    this.cache.set(path, parsed);
    return parsed;
  }
}

export interface Bundle {
  document: unknown;
  /** True when a value from another file was copied in. */
  inlined: boolean;
}

/** Where a 3.x bundle keeps each value it copied from another file, under `components`. */
const BUNDLED_KEY = "x-oxagen-bundled";

class Bundler {
  private readonly budget = new NodeBudget(PARSED_NODES_MAX, "The bundled document");
  /** OpenAPI 3.x only: where each value from another file was copied, so every $ref to it points there. */
  private readonly placed = new Map<string, string>();
  /** OpenAPI 3.x only: each copied value, by its name under components[BUNDLED_KEY]. */
  private readonly bundled = new Map<string, unknown>();
  /** Swagger 2.0 only: values the walk is inside now. A $ref to one of them closes a cycle. */
  private readonly active = new Set<string>();
  private readonly paths: ReadonlySet<string>;
  /** Each copied value's name: under components[BUNDLED_KEY] for 3.x, or under `definitions` for a 2.0 cycle. */
  private readonly names = new Map<string, string>();
  /** Swagger 2.0 only: each cycle's value, by its name under `definitions`. */
  private readonly definitions = new Map<string, unknown>();
  private readonly taken = new Set<string>();
  inlined = false;

  constructor(
    private readonly files: ParsedFiles,
    private readonly entry: string,
    private readonly reuse: boolean,
  ) {
    this.paths = files.paths;
  }

  /** Names the entry already holds where copies go, so a copy's name never replaces one. */
  reserve(names: readonly string[]): void {
    for (const name of names) this.taken.add(name);
  }

  walk(value: unknown, file: string, nameMap: boolean, depth: number): unknown {
    this.budget.spend();
    if (depth > DEPTH_MAX) throw depthError("The bundled document");
    if (Array.isArray(value)) return value.map((item) => this.walk(item, file, false, depth + 1));
    if (!isRecord(value)) return value;
    if (!nameMap && typeof value.$ref === "string") return this.ref(value, value.$ref, file, depth);
    return this.fields(value, file, nameMap, depth);
  }

  private fields(record: JsonRecord, file: string, nameMap: boolean, depth: number, skip?: string): JsonRecord {
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(record)) {
      if (key === skip) continue;
      if (!nameMap && isDataKey(key, item)) {
        entries.push([key, copyJson(item, this.budget, "The bundled document", depth + 1)]);
      } else {
        entries.push([key, this.walk(item, file, !nameMap && isNameMapKey(key, item), depth + 1)]);
      }
    }
    return Object.fromEntries(entries);
  }

  private ref(record: JsonRecord, ref: string, file: string, depth: number): unknown {
    const siblings = this.fields(record, file, false, depth, "$ref");
    if (ref.startsWith("#") && file === this.entry) return { $ref: ref, ...siblings };

    const target = resolveRefPath(ref, file, this.paths);
    const fragment = pointerFragment(target.tokens);
    if (target.file === this.entry) return { $ref: fragment, ...siblings };

    const key = `${target.file}${fragment}`;
    if (this.reuse) return { $ref: this.placed.get(key) ?? this.place(key, ref, file, target, depth), ...siblings };
    if (this.active.has(key)) {
      return { $ref: pointerFragment(["definitions", this.nameFor(key, target.tokens, target.file)]), ...siblings };
    }

    const value = this.targetValue(ref, file, target);
    this.inlined = true;
    this.active.add(key);
    let copy: unknown;
    try {
      copy = this.walk(value, target.file, false, depth);
    } finally {
      this.active.delete(key);
    }
    const name = this.names.get(key);
    if (name !== undefined && !this.definitions.has(name)) this.definitions.set(name, copy);
    return isRecord(copy) ? { ...copy, ...siblings } : copy;
  }

  private targetValue(ref: string, file: string, target: { file: string; tokens: readonly string[] }): unknown {
    const found = valueAt(this.files.get(target.file), target.tokens);
    if (!found.found) {
      throw new OpenApiImportError(
        "ref_missing",
        `The $ref "${ref}" in ${file} names a location ${target.file} does not have. Fix the $ref and import again.`,
        { ref },
      );
    }
    return found.value;
  }

  /**
   * Copies a value from another file to components[BUNDLED_KEY], and returns
   * the local $ref to the copy. The copy's place is recorded before its walk,
   * so a cycle back into it ends at a $ref to the copy.
   */
  private place(key: string, ref: string, file: string, target: { file: string; tokens: readonly string[] }, depth: number): string {
    const value = this.targetValue(ref, file, target);
    const name = this.nameFor(key, target.tokens, target.file);
    const pointer = pointerFragment(["components", BUNDLED_KEY, name]);
    this.placed.set(key, pointer);
    // The name takes its place now, so the copies keep the order of their first $ref.
    this.bundled.set(name, undefined);
    this.inlined = true;
    this.bundled.set(name, this.walk(value, target.file, false, depth));
    return pointer;
  }

  /**
   * The name a copied value takes: the last token of its pointer, or the
   * file's path without its extension for a whole file, with any character
   * outside letters, digits, _, ., and - written as _. For a Swagger 2.0
   * cycle, the converter moves `definitions` to components.schemas and
   * rewrites each `#/definitions/` $ref, so the cycle's $ref stays valid
   * after the upgrade.
   */
  private nameFor(key: string, tokens: readonly string[], file: string): string {
    const known = this.names.get(key);
    if (known !== undefined) return known;
    const last = tokens[tokens.length - 1] ?? file.replace(/\.[^./]*$/, "");
    const base = last.replace(/[^A-Za-z0-9_.-]/g, "_") || "Schema";
    let name = base;
    for (let n = 2; this.taken.has(name); n += 1) name = `${base}_${n}`;
    this.taken.add(name);
    this.names.set(key, name);
    return name;
  }

  /** The document with each copy added: under components[BUNDLED_KEY] for 3.x, or under `definitions` for a 2.0 cycle. */
  finish(document: unknown): unknown {
    if (!isRecord(document)) return document;
    if (this.bundled.size > 0) {
      const components = isRecord(document.components) ? document.components : {};
      const existing = isRecord(components[BUNDLED_KEY]) ? components[BUNDLED_KEY] : {};
      const copies = { ...existing, ...Object.fromEntries(this.bundled) };
      return { ...document, components: { ...components, [BUNDLED_KEY]: copies } };
    }
    if (this.definitions.size === 0) return document;
    const existing = isRecord(document.definitions) ? document.definitions : {};
    return { ...document, definitions: { ...existing, ...Object.fromEntries(this.definitions) } };
  }
}

/**
 * The entry with every value from another file copied in. With `reuse`
 * (OpenAPI 3.x), each value is copied once under components[BUNDLED_KEY],
 * and every $ref to it points there. Without it (Swagger 2.0), the value is
 * copied again at each $ref, and a $ref that closes a cycle points at a copy
 * under `definitions`.
 */
export function bundle(files: ParsedFiles, entry: string, reuse = true): Bundle {
  const bundler = new Bundler(files, entry, reuse);
  const root = files.get(entry);
  if (isRecord(root)) {
    const holder = reuse ? (isRecord(root.components) ? root.components[BUNDLED_KEY] : undefined) : root.definitions;
    if (isRecord(holder)) bundler.reserve(Object.keys(holder));
  }
  const document = bundler.finish(bundler.walk(root, entry, false, 0));
  return { document, inlined: bundler.inlined };
}

/** The text of a bundled document, in the entry's own format. */
export function bundleText(document: unknown, entry: string): string {
  if (entry.toLowerCase().endsWith(".json")) return `${JSON.stringify(document, null, 2)}\n`;
  return stringifyYaml(document, { lineWidth: 0, aliasDuplicateObjects: false });
}
