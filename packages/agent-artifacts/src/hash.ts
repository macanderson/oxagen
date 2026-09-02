import { createHash } from "node:crypto";
import canonicalJson from "canonical-json";
import { AgentArtifactError } from "./errors";
import { serializeArtifactToml } from "./codec";
import type { Artifact } from "./types";

// `seen` is the set of objects on the path from the root to `value`, not every
// object visited: entries are removed on the way back out, so a value shared by
// two sibling keys is fine and only a true cycle is rejected.
//
// The walk is recursive and unbounded, so a pathologically deep value throws a
// RangeError from the engine rather than an AgentArtifactError.
function assertCanonicalValue(value: unknown, seen: Set<object>): void {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new AgentArtifactError(
      "invalid_canonical_value",
      "undefined, functions, and symbols are not contract values",
    );
  }
  // `canonical-json` throws a bare TypeError on a BigInt. Catch it here so
  // callers get the same `invalid_canonical_value` code as every other
  // unrepresentable value instead of an error they cannot branch on.
  if (typeof value === "bigint") {
    throw new AgentArtifactError(
      "invalid_canonical_value",
      "bigints are not contract values; send them as strings",
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new AgentArtifactError(
      "invalid_canonical_value",
      "numbers must be finite",
    );
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) {
    throw new AgentArtifactError(
      "invalid_canonical_value",
      "cycles are not allowed",
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertCanonicalValue(item, seen);
  } else {
    for (const item of Object.values(value)) assertCanonicalValue(item, seen);
  }
  seen.delete(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * SHA-256 of a value's canonical JSON form: object keys sorted, so two values
 * that differ only in key order hash the same. Used for lifecycle input,
 * output, prompt, and idempotency-key hashes.
 *
 * Values JSON cannot faithfully carry are rejected up front rather than being
 * silently coerced, because a hash that quietly ignores a field is worse than
 * no hash at all.
 *
 * One hole is worth knowing about: the up-front check reads a value's own
 * enumerable properties, while the serializer first calls `toJSON()` when one
 * exists. A `toJSON` inherited from a prototype (a `Date`, a driver's number
 * wrapper) is therefore never inspected, so a non-finite number it returns is
 * written as `null` instead of being rejected. Hash values you built yourself,
 * not objects handed back by a driver.
 *
 * @throws {AgentArtifactError} `invalid_canonical_value` for `undefined`,
 * functions, symbols, bigints, non-finite numbers, or cycles.
 */
export function hashCanonicalJson(value: unknown): string {
  assertCanonicalValue(value, new Set());
  const serialized = canonicalJson(value);
  if (serialized === undefined) {
    throw new AgentArtifactError(
      "invalid_canonical_value",
      "value cannot be represented as canonical JSON",
    );
  }
  return sha256(serialized);
}

/**
 * The identity of an artifact: SHA-256 of its canonical TOML bytes. Two
 * artifacts hash the same exactly when they serialize the same, which is what
 * lets a receipt or an execution envelope cite an agent by hash.
 *
 * Because the input is serializer output, the hash is only as stable as
 * `smol-toml`'s formatting — the dependency is pinned to an exact version for
 * that reason.
 */
export function hashArtifact(value: Artifact): string {
  return sha256(serializeArtifactToml(value));
}
