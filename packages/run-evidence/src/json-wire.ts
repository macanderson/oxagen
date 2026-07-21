import { isProxy } from "node:util/types";

export type JsonWireValue =
  | null
  | boolean
  | number
  | string
  | JsonWireValue[]
  | { [key: string]: JsonWireValue };

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

function snapshotArray(
  value: unknown[],
  path: string,
  ancestors: Set<object>,
): JsonWireValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${path} must have the ordinary array prototype`);
  }

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    throw new TypeError(`${path} must have an own data length property`);
  }
  const length = lengthDescriptor.value as number;
  const allowedKeys = new Set<PropertyKey>();
  allowedKeys.add("length");
  const descriptors: PropertyDescriptor[] = [];
  descriptors.length = length;

  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new TypeError(
        `${path}[${index}] must be an enumerable data property`,
      );
    }
    Object.defineProperty(descriptors, String(index), {
      configurable: true,
      enumerable: true,
      value: descriptor,
      writable: true,
    });
    allowedKeys.add(String(index));
  }

  const ownKeys = Reflect.ownKeys(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (key === undefined) {
      throw new TypeError(`${path} contains an invalid array property`);
    }
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${path} contains a non-JSON array property`);
    }
  }

  const snapshot: JsonWireValue[] = [];
  snapshot.length = length;
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${path}[${index}] changed during validation`);
    }
    Object.defineProperty(snapshot, String(index), {
      configurable: true,
      enumerable: true,
      value: snapshotValue(descriptor.value, `${path}[${index}]`, ancestors),
      writable: true,
    });
  }
  return snapshot;
}

function snapshotObject(
  value: object,
  path: string,
  ancestors: Set<object>,
): { [key: string]: JsonWireValue } {
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} must be a plain object`);
  }

  const snapshot = Object.create(null) as { [key: string]: JsonWireValue };
  const ownKeys = Reflect.ownKeys(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
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
      throw new TypeError(`${path}.${key} must be an enumerable data property`);
    }
    Object.defineProperty(snapshot, key, {
      configurable: false,
      enumerable: true,
      value: snapshotValue(descriptor.value, `${path}.${key}`, ancestors),
      writable: false,
    });
  }
  return snapshot;
}

function snapshotValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): JsonWireValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must be a finite binary64 number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} is not an I-JSON value`);
  }
  if (isProxy(value)) {
    throw new TypeError(`${path} must not be a Proxy`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a cycle`);
  }

  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? snapshotArray(value, path, ancestors)
      : snapshotObject(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

export function snapshotJsonWire(value: unknown): JsonWireValue {
  return snapshotValue(value, "$", new Set());
}
