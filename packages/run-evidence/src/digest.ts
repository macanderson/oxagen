import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

export type Sha256Digest = `sha256:${string}`;

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${path} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${path} contains an unpaired low surrogate`);
    }
  }
}

function assertArrayShape(value: unknown[], path: string): void {
  const allowedKeys = new Set<PropertyKey>(["length"]);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${path} must not be sparse`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(
        `${path}[${index}] must be an enumerable data property`,
      );
    }
    allowedKeys.add(String(index));
  }

  for (const key of Reflect.ownKeys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${path} contains a non-JSON array property`);
    }
  }
}

function assertIJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite binary64 number`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} is not an I-JSON value`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a cycle`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertArrayShape(value, path);
      for (let index = 0; index < value.length; index += 1) {
        assertIJsonValue(value[index], `${path}[${index}]`, ancestors);
      }
      return;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${path} must be a plain object`);
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(`${path} contains a symbol property`);
      }
      assertUnicodeScalarString(key, `${path} property name`);

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError(
          `${path}.${key} must be an enumerable data property`,
        );
      }
      assertIJsonValue(descriptor.value, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

export function jcsBytes(value: unknown): Uint8Array {
  assertIJsonValue(value, "$", new Set());
  const canonical = canonicalize(value);
  if (canonical === undefined) {
    throw new TypeError("value cannot be represented as JCS");
  }
  return new TextEncoder().encode(canonical);
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
