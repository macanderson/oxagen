import { z } from "zod";
import { snapshotJsonWire } from "./json-wire.js";

export const CONTEXTGRAPH_PROTOCOL_VERSION = "contextgraph/1.0-draft" as const;
export const CONTEXTGRAPH_FIXTURE_PROFILE_VERSION = "1.1.0" as const;

const u32Schema = z.number().int().min(0).max(0xffff_ffff);
const finiteNumberSchema = z.number().finite();
const f32NumberSchema = finiteNumberSchema.refine(
  (value) => Number.isFinite(Math.fround(value)),
  { message: "embedding value must be representable as a finite f32" },
);

interface DescriptorSnapshot {
  configurable: boolean;
  enumerable: boolean;
  get: (() => unknown) | undefined;
  isData: boolean;
  set: ((value: unknown) => void) | undefined;
  value: unknown;
  writable: boolean | undefined;
}

interface PrototypeEntry {
  descriptor: DescriptorSnapshot;
  key: PropertyKey;
}

interface IndexedSnapshot<T> {
  readonly [index: number]: T;
  readonly length: number;
}

interface PrototypeSnapshot {
  entries: IndexedSnapshot<PrototypeEntry>;
  label: string;
  target: object;
}

function defineReadonly(
  target: object,
  key: PropertyKey,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
}

function createIndexedSnapshot<T>(length: number): IndexedSnapshot<T> {
  const snapshot = Object.create(null) as IndexedSnapshot<T>;
  defineReadonly(snapshot, "length", length);
  return snapshot;
}

function captureDescriptor(descriptor: PropertyDescriptor): DescriptorSnapshot {
  const isData = Object.hasOwn(descriptor, "value");
  const snapshot = Object.create(null) as DescriptorSnapshot;
  defineReadonly(snapshot, "configurable", descriptor.configurable === true);
  defineReadonly(snapshot, "enumerable", descriptor.enumerable === true);
  defineReadonly(snapshot, "isData", isData);
  defineReadonly(
    snapshot,
    "writable",
    isData ? descriptor.writable === true : undefined,
  );
  defineReadonly(snapshot, "value", isData ? descriptor.value : undefined);
  defineReadonly(snapshot, "get", isData ? undefined : descriptor.get);
  defineReadonly(snapshot, "set", isData ? undefined : descriptor.set);
  return Object.freeze(snapshot);
}

function capturePrototype(label: string, target: object): PrototypeSnapshot {
  const keys = Reflect.ownKeys(target);
  const entries = createIndexedSnapshot<PrototypeEntry>(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as PropertyKey;
    const descriptor = Object.getOwnPropertyDescriptor(
      target,
      key,
    ) as PropertyDescriptor;
    const entry = Object.create(null) as PrototypeEntry;
    defineReadonly(entry, "key", key);
    defineReadonly(entry, "descriptor", captureDescriptor(descriptor));
    defineReadonly(entries, String(index), Object.freeze(entry));
  }

  const snapshot = Object.create(null) as PrototypeSnapshot;
  defineReadonly(snapshot, "label", label);
  defineReadonly(snapshot, "target", target);
  defineReadonly(snapshot, "entries", Object.freeze(entries));
  return Object.freeze(snapshot);
}

// Security boundary: these intrinsics are assumed pristine when this module
// initializes. A total compromise before module initialization is out of scope.
const protectedPrototypes = createIndexedSnapshot<PrototypeSnapshot>(4);
defineReadonly(
  protectedPrototypes,
  "0",
  capturePrototype("Array.prototype", Array.prototype),
);
defineReadonly(
  protectedPrototypes,
  "1",
  capturePrototype("Object.prototype", Object.prototype),
);
defineReadonly(
  protectedPrototypes,
  "2",
  capturePrototype("Set.prototype", Set.prototype),
);
defineReadonly(
  protectedPrototypes,
  "3",
  capturePrototype("String.prototype", String.prototype),
);
Object.freeze(protectedPrototypes);

function descriptorsMatch(
  expected: DescriptorSnapshot,
  actual: PropertyDescriptor,
): boolean {
  if (
    expected.configurable !== (actual.configurable === true) ||
    expected.enumerable !== (actual.enumerable === true)
  ) {
    return false;
  }

  const actualIsData = Object.hasOwn(actual, "value");
  if (expected.isData !== actualIsData) {
    return false;
  }
  if (actualIsData) {
    return (
      expected.writable === (actual.writable === true) &&
      Object.is(expected.value, actual.value)
    );
  }
  return (
    Object.is(expected.get, actual.get) && Object.is(expected.set, actual.set)
  );
}

function assertIntrinsicIntegrity(): void {
  for (
    let prototypeIndex = 0;
    prototypeIndex < protectedPrototypes.length;
    prototypeIndex += 1
  ) {
    const snapshot = protectedPrototypes[prototypeIndex] as PrototypeSnapshot;
    if (Reflect.ownKeys(snapshot.target).length !== snapshot.entries.length) {
      throw new TypeError(
        `${snapshot.label} was modified after initialization`,
      );
    }

    for (
      let entryIndex = 0;
      entryIndex < snapshot.entries.length;
      entryIndex += 1
    ) {
      const entry = snapshot.entries[entryIndex] as PrototypeEntry;
      const currentDescriptor = Object.getOwnPropertyDescriptor(
        snapshot.target,
        entry.key,
      );
      if (
        currentDescriptor === undefined ||
        !descriptorsMatch(entry.descriptor, currentDescriptor)
      ) {
        throw new TypeError(
          `${snapshot.label} was modified after initialization`,
        );
      }
    }
  }
}

const contextFrameKindV1Schema = z.enum([
  "snippet",
  "symbol",
  "fact",
  "doc",
  "memory",
  "episode",
  "graph",
]);

const contextProvenanceV1Schema = z
  .object({
    type: z.string(),
    uri: z.string().optional(),
    range: z.string().optional(),
    digest: z.string().optional(),
    method: z.string().optional(),
    by: z.string().optional(),
  })
  .strict();

const contextFrameEmbeddingV1Schema = z
  .object({
    fingerprint: z.string(),
    vector: z.array(f32NumberSchema).optional(),
  })
  .strict();

const contextRelationV1Schema = z
  .object({
    rel: z.string(),
    target_uri: z.string(),
    display_name: z.string().optional(),
  })
  .strict();

const contextFrameV1Schema = z
  .object({
    id: z.string(),
    kind: contextFrameKindV1Schema,
    title: z.string(),
    content: z.string(),
    uri: z.string().optional(),
    score: finiteNumberSchema.min(0).max(1),
    token_cost: u32Schema,
    valid_from: z.string().optional(),
    valid_to: z.string().optional(),
    recorded_at: z.string().optional(),
    provenance: z.array(contextProvenanceV1Schema).default([]),
    citation_label: z.string().refine((value) => value.trim().length > 0, {
      message: "citation_label must not be blank",
    }),
    embedding: contextFrameEmbeddingV1Schema.optional(),
    relations: z.array(contextRelationV1Schema).default([]),
  })
  .strict();

const contextQueryV1Schema = z
  .object({
    goal: z.string(),
    query_text: z.string().optional(),
    embedding: z.array(f32NumberSchema).optional(),
    kinds: z.array(contextFrameKindV1Schema).default([]),
    anchors: z.array(z.string()).default([]),
    max_frames: u32Schema,
    max_tokens: u32Schema,
    as_of: z.string().optional(),
  })
  .strict();

export type ContextFrameKindV1 = z.infer<typeof contextFrameKindV1Schema>;
export type ContextProvenanceV1 = z.infer<typeof contextProvenanceV1Schema>;
export type ContextFrameEmbeddingV1 = z.infer<
  typeof contextFrameEmbeddingV1Schema
>;
export type ContextRelationV1 = z.infer<typeof contextRelationV1Schema>;
export type ContextFrameV1 = z.infer<typeof contextFrameV1Schema>;
export type ContextQueryV1 = z.infer<typeof contextQueryV1Schema>;

export function normalizeContextFrameV1(input: unknown): ContextFrameV1 {
  assertIntrinsicIntegrity();
  return contextFrameV1Schema.parse(snapshotJsonWire(input));
}

export function normalizeContextQueryV1(input: unknown): ContextQueryV1 {
  assertIntrinsicIntegrity();
  return contextQueryV1Schema.parse(snapshotJsonWire(input));
}
