// bundle.ts: a document split across files, as one document.
//
// The walk starts at the entry and copies it. Each $ref to another file is
// replaced by the value it points at, the first time import meets it. Every
// later $ref to the same value points at that first copy, so a cycle across
// files ends at a local $ref instead of recursing. A $ref with other keys
// beside it merges them into its copy, so only a copy made at a bare $ref is
// reused: a later $ref must not inherit another site's keys. A $ref into the
// entry becomes a local `#/` ref. Import never reads a disk or fetches a URL:
// ref-path.ts resolves every ref against the files it was given.
//
// A Swagger 2.0 document is converted after the bundle, and the converter
// moves values: a body parameter becomes a requestBody, and a response's
// schema moves under content. A local $ref into a moved value would point at
// nothing. So for 2.0 the bundle copies a value again at each later $ref,
// and writes a local $ref only to close a cycle, where the target is a
// schema the converter leaves in place.
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

class Bundler {
  private readonly budget = new NodeBudget(PARSED_NODES_MAX, "The bundled document");
  /** Where each value's first copy made at a bare $ref sits, so a later $ref can point at it. */
  private readonly placed = new Map<string, string>();
  /** Where each value the walk is copying at a $ref with other keys sits, for a cycle with no bare copy to end at. */
  private readonly decorated = new Map<string, string>();
  /** Values the walk is inside now. A $ref to one of them closes a cycle. */
  private readonly active = new Set<string>();
  private readonly path: string[] = [];
  private readonly paths: ReadonlySet<string>;
  /** Swagger 2.0 only: each cycle's value, by the name it takes under `definitions`. */
  private readonly cycleNames = new Map<string, string>();
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

  /** Names the entry's own `definitions` already holds, so a cycle's name never replaces one. */
  reserve(names: readonly string[]): void {
    for (const name of names) this.taken.add(name);
  }

  walk(value: unknown, file: string, nameMap: boolean, depth: number): unknown {
    this.budget.spend();
    if (depth > DEPTH_MAX) throw depthError("The bundled document");
    if (Array.isArray(value)) {
      return value.map((item, index) => this.child(String(index), item, file, false, depth));
    }
    if (!isRecord(value)) return value;
    if (!nameMap && typeof value.$ref === "string") return this.ref(value, value.$ref, file, depth);
    return this.fields(value, file, nameMap, depth);
  }

  private child(key: string, value: unknown, file: string, nameMap: boolean, depth: number): unknown {
    this.path.push(key);
    try {
      return this.walk(value, file, nameMap, depth + 1);
    } finally {
      this.path.pop();
    }
  }

  private fields(record: JsonRecord, file: string, nameMap: boolean, depth: number, skip?: string): JsonRecord {
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(record)) {
      if (key === skip) continue;
      if (!nameMap && isDataKey(key, item)) {
        entries.push([key, copyJson(item, this.budget, "The bundled document", depth + 1)]);
      } else {
        entries.push([key, this.child(key, item, file, !nameMap && isNameMapKey(key, item), depth)]);
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
    const bare = Object.keys(siblings).length === 0;
    if (this.reuse) {
      const placed = this.placed.get(key);
      if (placed !== undefined) return { $ref: placed, ...siblings };
      // A cycle back into a copy with other keys. A bare $ref copies the value
      // again below and becomes the copy later $refs reuse. A $ref with keys of
      // its own would copy forever, so it points at the outer copy, keys and all.
      const outer = this.decorated.get(key);
      if (outer !== undefined && !bare) return { $ref: outer, ...siblings };
    } else if (this.active.has(key)) {
      return { $ref: pointerFragment(["definitions", this.cycleName(key, target.tokens, target.file)]), ...siblings };
    }

    const found = valueAt(this.files.get(target.file), target.tokens);
    if (!found.found) {
      throw new OpenApiImportError(
        "ref_missing",
        `The $ref "${ref}" in ${file} names a location ${target.file} does not have. Fix the $ref and import again.`,
        { ref },
      );
    }
    const here = pointerFragment(this.path);
    const opened = this.reuse && !bare;
    if (this.reuse && bare) this.placed.set(key, here);
    if (opened) this.decorated.set(key, here);
    this.inlined = true;
    this.active.add(key);
    let copy: unknown;
    try {
      copy = this.walk(found.value, target.file, false, depth);
    } finally {
      this.active.delete(key);
      if (opened) this.decorated.delete(key);
    }
    const name = this.cycleNames.get(key);
    if (name !== undefined && !this.definitions.has(name)) this.definitions.set(name, copy);
    return isRecord(copy) ? { ...copy, ...siblings } : copy;
  }

  /**
   * The name a Swagger 2.0 cycle's value takes under `definitions`. The
   * converter moves `definitions` to components.schemas and rewrites each
   * `#/definitions/` $ref, so the cycle's $ref stays valid after the upgrade.
   */
  private cycleName(key: string, tokens: readonly string[], file: string): string {
    const known = this.cycleNames.get(key);
    if (known !== undefined) return known;
    const last = tokens[tokens.length - 1] ?? file.replace(/^.*\//, "").replace(/\.[^.]*$/, "");
    const base = last.replace(/[^A-Za-z0-9_.-]/g, "_") || "Schema";
    let name = base;
    for (let n = 2; this.taken.has(name); n += 1) name = `${base}_${n}`;
    this.taken.add(name);
    this.cycleNames.set(key, name);
    return name;
  }

  /** The document with each cycle's value added under `definitions`. */
  finish(document: unknown): unknown {
    if (this.definitions.size === 0 || !isRecord(document)) return document;
    const existing = isRecord(document.definitions) ? document.definitions : {};
    return { ...document, definitions: { ...existing, ...Object.fromEntries(this.definitions) } };
  }
}

/**
 * The entry with every value from another file copied in. With `reuse`, a
 * later $ref to a value points at its first copy made at a bare $ref.
 * Without it, the value is copied again, and a $ref that closes a cycle
 * points at a copy under `definitions`.
 */
export function bundle(files: ParsedFiles, entry: string, reuse = true): Bundle {
  const bundler = new Bundler(files, entry, reuse);
  const root = files.get(entry);
  if (!reuse && isRecord(root) && isRecord(root.definitions)) bundler.reserve(Object.keys(root.definitions));
  const document = bundler.finish(bundler.walk(root, entry, false, 0));
  return { document, inlined: bundler.inlined };
}

/** The text of a bundled document, in the entry's own format. */
export function bundleText(document: unknown, entry: string): string {
  if (entry.toLowerCase().endsWith(".json")) return `${JSON.stringify(document, null, 2)}\n`;
  return stringifyYaml(document, { lineWidth: 0, aliasDuplicateObjects: false });
}
