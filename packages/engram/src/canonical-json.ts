/**
 * Canonical JSON serialization for content addressing.
 *
 * `JSON.stringify` preserves insertion order of object keys, so two objects
 * with identical content but different key order serialize to different
 * strings — and therefore hash to different record IDs. That silently breaks
 * content-addressed dedup: the same fact written by two code paths (or the
 * same object rebuilt after a round-trip through a store) can land as two
 * records.
 *
 * `canonicalStringify` produces a stable, key-sorted serialization so identical
 * content always yields identical bytes regardless of key order. It is the
 * single source of truth for any hash-input serialization in engram
 * (record IDs, OR-Set element identity).
 *
 * Content addressing needs the biconditional, not half of it. Same logical
 * value must produce the same bytes, and — the half that is easy to lose —
 * different logical values must produce different bytes. A serializer that
 * renders two distinct values identically hands them one record ID, and the
 * second write dedups onto the first: a wrong record read back, with an intact
 * integrity check, because the content really does hash to the ID it is filed
 * under.
 *
 * So every value reaching this function is either represented faithfully or
 * refused. There is no third branch that emits something lossy:
 *
 * - **Objects with a `toJSON()`** serialize by its result, as
 *   `JSON.stringify` does. A `Date` therefore hashes as its ISO string, and
 *   two instants are two IDs.
 * - **Plain objects** (prototype `Object.prototype` or `null`) serialize with
 *   keys sorted lexicographically — UTF-16 code unit order, which is RFC
 *   8785's rule and what `Array#sort` does by default.
 * - **Arrays** keep their order, because order is semantically meaningful.
 * - **Every other object** — `Map`, `Set`, `RegExp`, a class instance with no
 *   `toJSON` — throws {@link CanonicalJsonError}. None of them has a canonical
 *   JSON form: `Object.keys` returns `[]` for all of them, so the only
 *   alternative to refusing them is emitting `{}` and colliding every one with
 *   every other. Convert such a value to a primitive (e.g. `[...set].sort()`)
 *   before it reaches a hashed body.
 * - **Cycles** throw rather than recursing until the stack overflows.
 *
 * `undefined`, functions and symbols keep JSON semantics: dropped as an object
 * value, `null` as an array element, so an absent key and an explicit
 * `undefined` hash identically.
 *
 * This module deliberately does **not** reuse `@oxagen/run-evidence`'s RFC 8785
 * implementation. That one snapshots a value across a wire boundary against a
 * hostile peer — captured intrinsics, proxy rejection, surrogate validation —
 * and pulls the CGP SDK in with it. Engram hashes trusted in-process values, so
 * it takes the same *rule* (plain JSON or a loud error) without the isolation
 * machinery. See ADR-041.
 */

/**
 * A value was handed to {@link canonicalStringify} that has no canonical JSON
 * form. Carries the path to the offending value so the caller can find it in a
 * nested body.
 */
export class CanonicalJsonError extends TypeError {
  /** Dotted path from the root of the hashed value, `""` at the root. */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`canonicalStringify: ${path === "" ? "<root>" : path}: ${reason}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

/**
 * Serialize a value to a canonical string with recursively sorted object keys.
 *
 * @throws {CanonicalJsonError} if the value contains an object with no
 * canonical JSON form (`Map`, `Set`, `RegExp`, a class instance without
 * `toJSON`), or a cycle.
 */
export function canonicalStringify(value: unknown): string {
  return serialize(value, "", new Set<object>());
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function serialize(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "number")
    return Number.isFinite(value as number) ? String(value) : "null";
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "bigint") return JSON.stringify((value as bigint).toString());
  // undefined / function / symbol have no JSON representation on their own.
  if (t === "undefined" || t === "function" || t === "symbol") return "null";

  const object = value as object;

  if (ancestors.has(object)) {
    throw new CanonicalJsonError(path, "circular reference");
  }

  // `toJSON` first, exactly as JSON.stringify resolves it — this is what makes
  // a Date hash as its instant rather than as its (empty) enumerable keys.
  const toJson = (object as { toJSON?: unknown }).toJSON;
  if (typeof toJson === "function") {
    const replaced = (toJson as (key: string) => unknown).call(object, "");
    // A toJSON returning the object itself would otherwise spin forever.
    if (replaced === object) {
      throw new CanonicalJsonError(path, "toJSON() returned its own receiver");
    }
    ancestors.add(object);
    try {
      return serialize(replaced, path, ancestors);
    } finally {
      ancestors.delete(object);
    }
  }

  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item, index) =>
        serializeElement(item, join(path, String(index)), ancestors),
      );
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(object) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      const name =
        (object.constructor as { name?: string } | undefined)?.name ??
        "unknown";
      throw new CanonicalJsonError(
        path,
        `non-plain object (${name}) has no canonical JSON form; ` +
          "convert it to a primitive before hashing",
      );
    }

    // Plain object: sort keys, drop keys whose value is undefined/function/
    // symbol (matching JSON.stringify), recurse.
    const record = object as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      const vt = typeof v;
      if (v === undefined || vt === "function" || vt === "symbol") continue;
      parts.push(
        `${JSON.stringify(key)}:${serialize(v, join(path, key), ancestors)}`,
      );
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Array elements serialize like object values under JSON.stringify: an
 * `undefined`/function/symbol element becomes `null` (not dropped), preserving
 * positional meaning.
 */
function serializeElement(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string {
  const t = typeof value;
  if (value === undefined || t === "function" || t === "symbol") return "null";
  return serialize(value, path, ancestors);
}
