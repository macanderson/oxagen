import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { type JsonWireValue, snapshotJsonWire } from "./json-wire.js";

export type Sha256Digest = `sha256:${string}`;

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const intrinsicArraySort = Array.prototype.sort;

function canonicalizePrimitive(
  value: null | boolean | number | string,
): string {
  const result = canonicalize(value);
  if (result === undefined) {
    throw new TypeError("primitive cannot be represented as JCS");
  }
  return result;
}

function compareUtf16(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function sortUtf16(keys: string[]): void {
  Reflect.apply(intrinsicArraySort, keys, [compareUtf16]);
}

function serializeSnapshot(value: JsonWireValue): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return canonicalizePrimitive(value);
  }

  if (Array.isArray(value)) {
    let result = "[";
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("invalid JSON snapshot array");
      }
      if (index > 0) {
        result += ",";
      }
      result += serializeSnapshot(descriptor.value as JsonWireValue);
    }
    return `${result}]`;
  }

  const ownKeys = Reflect.ownKeys(value);
  const keys: string[] = [];
  keys.length = ownKeys.length;
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== "string") {
      throw new TypeError("invalid JSON snapshot object");
    }
    Object.defineProperty(keys, String(index), {
      configurable: true,
      enumerable: true,
      value: key,
      writable: true,
    });
  }
  sortUtf16(keys);

  let result = "{";
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      throw new TypeError("invalid JSON snapshot object key");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("invalid JSON snapshot object property");
    }
    if (index > 0) {
      result += ",";
    }
    result += `${canonicalizePrimitive(key)}:${serializeSnapshot(
      descriptor.value as JsonWireValue,
    )}`;
  }
  return `${result}}`;
}

export function jcsBytes(value: unknown): Uint8Array {
  // This generic primitive intentionally has no envelope policy. Task 2B owns
  // the 1 MiB envelope guard; O(k log k) ordering prevents key-sort amplification.
  return new TextEncoder().encode(serializeSnapshot(snapshotJsonWire(value)));
}

export function sha256Digest(bytes: Uint8Array): Sha256Digest {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("sha256Digest requires exact bytes");
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function assertDigest(value: unknown): Sha256Digest {
  if (typeof value !== "string" || !SHA256_DIGEST_PATTERN.test(value)) {
    throw new TypeError(
      "digest must be sha256: followed by 64 lowercase hex digits",
    );
  }
  return value as Sha256Digest;
}

export function digestJcs(value: unknown): Sha256Digest {
  return sha256Digest(jcsBytes(value));
}
