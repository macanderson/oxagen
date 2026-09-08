/**
 * registry-digest — canonical JSON + SHA-256 for the agent-asset registry.
 *
 * The immutability contract for tool_versions / context_record_versions /
 * context_promotions rows, mirroring skillBodyChecksum: a stored version can
 * later be proven byte-identical to what was published, and a promotion
 * ledger entry can be re-verified against its predecessor. Canonicalization
 * is recursive key-sorting (object key order must not change the digest);
 * arrays keep their order because order is meaning there.
 *
 * A digest is only worth as much as its inverse. Same value must produce the
 * same digest — and different values must produce different ones, which is the
 * half that is easy to lose. `typeof x === "object"` is true for a `Date`, a
 * `Map` and a `Set`, and `Object.keys` returns `[]` for all three, so a walk
 * that falls through to the plain-object branch renders every one of them as
 * `{}` and hands them all one digest. For a promotion ledger that means two
 * different entries verifying against the same predecessor.
 *
 * So a value is either represented faithfully or refused (ADR-041):
 * `toJSON()` is honoured, so a `Date` digests as its ISO string exactly as
 * `JSON.stringify` renders it; anything else that is not a plain object throws
 * {@link CanonicalJsonError} naming the constructor and the path.
 */
import { createHash } from "node:crypto";

/**
 * A value with no canonical JSON form reached {@link canonicalJson}. Carries
 * the path so the offending field can be found in a nested row.
 */
export class CanonicalJsonError extends TypeError {
  /** Dotted path from the root of the digested value, `""` at the root. */
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`canonicalJson: ${path === "" ? "<root>" : path}: ${reason}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

/**
 * Serialize a value with recursively sorted object keys.
 *
 * @throws {CanonicalJsonError} on a `Map`, `Set`, `RegExp`, a class instance
 * with no `toJSON`, or a cycle.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value, "", new Set<object>()));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function sortKeysDeep(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const object = value as object;
  if (ancestors.has(object)) {
    throw new CanonicalJsonError(path, "circular reference");
  }

  // `toJSON` first, as JSON.stringify resolves it — this is what makes a Date
  // digest as its instant rather than as its (empty) enumerable keys.
  const toJson = (object as { toJSON?: unknown }).toJSON;
  if (typeof toJson === "function") {
    const replaced = (toJson as (key: string) => unknown).call(object, "");
    if (replaced === object) {
      throw new CanonicalJsonError(path, "toJSON() returned its own receiver");
    }
    ancestors.add(object);
    try {
      return sortKeysDeep(replaced, path, ancestors);
    } finally {
      ancestors.delete(object);
    }
  }

  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        sortKeysDeep(item, join(path, String(index)), ancestors),
      );
    }

    const prototype = Object.getPrototypeOf(object) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      const name =
        (object.constructor as { name?: string } | undefined)?.name ??
        "unknown";
      throw new CanonicalJsonError(
        path,
        `non-plain object (${name}) has no canonical JSON form; ` +
          "convert it to a primitive before digesting",
      );
    }

    const record = object as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key], join(path, key), ancestors);
    }
    return sorted;
  } finally {
    ancestors.delete(object);
  }
}
