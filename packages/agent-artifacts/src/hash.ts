import { createHash } from "node:crypto";
import canonicalJson from "canonical-json";
import { AgentArtifactError } from "./errors";
import { serializeArtifactToml } from "./codec";
import type { Artifact } from "./types";

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

export function hashArtifact(value: Artifact): string {
  return sha256(serializeArtifactToml(value));
}
