// util.ts: small helpers the executor's modules share.

/** An error's message, or the value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for a plain JSON object: not null and not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for an array. Unlike Array.isArray, it narrows to unknown[], not any[]. */
export function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** True when two JSON values are equal. Object key order does not matter. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

/** A request the executor could not build. The title and message become the isError result. */
export class BuildError extends Error {
  readonly title: string;

  constructor(title: string, message: string) {
    super(message);
    this.name = "BuildError";
    this.title = title;
  }
}

/** The value at a dotted result path such as pageInfo.endCursor. A [] step reads no further. */
export function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const step of path.split(".")) {
    if (step.endsWith("[]") || !isRecord(current) || !Object.hasOwn(current, step)) return undefined;
    current = current[step];
  }
  return current;
}

/**
 * A copy of value with the dotted path set to replacement. Objects on the way
 * are copied, never changed. A path that passes through something other than
 * an object leaves value as it is.
 */
export function withValueAt(value: unknown, path: string, replacement: unknown): unknown {
  const [step, ...rest] = path.split(".");
  if (step === undefined || !isRecord(value)) return value;
  const inner = Object.hasOwn(value, step) ? value[step] : undefined;
  if (rest.length > 0 && !isRecord(inner)) return value;
  const next = rest.length === 0 ? replacement : withValueAt(inner, rest.join("."), replacement);
  // A computed key defines an own property, so __proto__ stays data.
  return { ...value, [step]: next };
}
