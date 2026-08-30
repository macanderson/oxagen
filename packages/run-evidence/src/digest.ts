import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { type JsonWireValue, snapshotJsonWire } from "./json-wire";

export type Sha256Digest = `sha256:${string}`;

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const intrinsicArraySort = Array.prototype.sort;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicRegExpTest = RegExp.prototype.test;
const intrinsicTextEncoderConstructor = TextEncoder;
const intrinsicTextEncoderEncode = TextEncoder.prototype.encode;
const intrinsicUint8ArrayConstructor = Uint8Array;
const intrinsicHashPrototype = Object.getPrototypeOf(
  createHash("sha256"),
) as object;
const intrinsicHashUpdate = Object.getOwnPropertyDescriptor(
  intrinsicHashPrototype,
  "update",
)?.value as (...arguments_: unknown[]) => unknown;
const intrinsicHashDigest = Object.getOwnPropertyDescriptor(
  intrinsicHashPrototype,
  "digest",
)?.value as (...arguments_: unknown[]) => unknown;

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

  if (intrinsicArrayIsArray(value)) {
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
  // This function has no size limit of its own — callers enforce the 1 MiB
  // envelope cap. Keys are sorted with the array sort, so large objects don't
  // hash in quadratic time.
  const encoder = new intrinsicTextEncoderConstructor();
  return Reflect.apply(intrinsicTextEncoderEncode, encoder, [
    serializeSnapshot(snapshotJsonWire(value)),
  ]) as Uint8Array;
}

export function sha256Digest(bytes: Uint8Array): Sha256Digest {
  if (!(bytes instanceof intrinsicUint8ArrayConstructor)) {
    throw new TypeError("sha256Digest requires exact bytes");
  }
  const hash = createHash("sha256");
  Reflect.apply(intrinsicHashUpdate, hash, [bytes]);
  const hex = Reflect.apply(intrinsicHashDigest, hash, ["hex"]) as string;
  return `sha256:${hex}`;
}

export function assertDigest(value: unknown): Sha256Digest {
  if (
    typeof value !== "string" ||
    !(Reflect.apply(intrinsicRegExpTest, SHA256_DIGEST_PATTERN, [
      value,
    ]) as boolean)
  ) {
    throw new TypeError(
      "digest must be sha256: followed by 64 lowercase hex digits",
    );
  }
  return value as Sha256Digest;
}

export function digestJcs(value: unknown): Sha256Digest {
  return sha256Digest(jcsBytes(value));
}
