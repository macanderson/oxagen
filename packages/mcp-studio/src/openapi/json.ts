// json.ts: the small JSON helpers every step of OpenAPI import shares.
import { OpenApiImportError, count } from "./errors";
import { DEPTH_MAX } from "./limits";

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An array, typed so each item is unknown rather than any. */
export function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** Sets an own property, so a key named `__proto__` stays data. */
export function setOwn(record: JsonRecord, key: string, value: unknown): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A string field of a record, or undefined when it is absent or not a string. */
export function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/** A record field of a record, or undefined. */
export function recordField(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

/**
 * Counts the nodes one step produces. It refuses the import when the count
 * passes the limit, so a document built to expand without end stops early.
 */
export class NodeBudget {
  private used = 0;

  constructor(
    readonly max: number,
    private readonly what: string,
  ) {}

  spend(): void {
    this.used += 1;
    if (this.used > this.max) {
      throw new OpenApiImportError(
        "expansion_limit",
        `${this.what} passed ${count(this.max)} nodes, the limit for one import. ` +
          "Remove unused operations or split the document, then import again.",
        { limit: this.max },
      );
    }
  }
}

export function depthError(where: string): OpenApiImportError {
  return new OpenApiImportError(
    "depth_limit",
    `${where} nests deeper than ${DEPTH_MAX} levels, the limit for one import. ` +
      "Flatten the nesting and import again.",
    { limit: DEPTH_MAX },
  );
}

/**
 * A deep copy of parsed JSON that counts every node and refuses past the
 * depth limit. A non-finite number, which JSON cannot hold, becomes null.
 *
 * Each object is built with `Object.fromEntries`, which defines every key as
 * an own property, so a key named `__proto__` stays data.
 */
export function copyJson(value: unknown, budget: NodeBudget, where: string, depth = 0): unknown {
  budget.spend();
  if (depth > DEPTH_MAX) throw depthError(where);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => copyJson(item, budget, where, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, copyJson(item, budget, where, depth + 1)]),
  );
}

function sortedKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortedKeys);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys((value as JsonRecord)[key])]),
  );
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortedKeys(a)) === JSON.stringify(sortedKeys(b));
}

/** The tokens of a JSON Pointer: "/paths/~1pets" is ["paths", "/pets"]. */
export function pointerTokens(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** A URI fragment for a JSON Pointer's tokens: #/paths/~1pets~1%7Bid%7D. */
export function pointerFragment(tokens: readonly string[]): string {
  return `#${tokens
    .map((token) => `/${encodeURIComponent(token.replace(/~/g, "~0").replace(/\//g, "~1"))}`)
    .join("")}`;
}

/** The value at a JSON Pointer's tokens, or `found: false`. */
export function valueAt(root: unknown, tokens: readonly string[]): { found: boolean; value: unknown } {
  let current = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return { found: false, value: undefined };
      const index = Number(token);
      if (index >= current.length) return { found: false, value: undefined };
      current = current[index];
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}
