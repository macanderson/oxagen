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

const arrayPrototypeKeys = Reflect.ownKeys(Array.prototype);
const arrayPrototypeDescriptors: PropertyDescriptor[] = [];
arrayPrototypeDescriptors.length = arrayPrototypeKeys.length;
for (let index = 0; index < arrayPrototypeKeys.length; index += 1) {
  const key = arrayPrototypeKeys[index] as PropertyKey;
  const descriptor = Object.getOwnPropertyDescriptor(
    Array.prototype,
    key,
  ) as PropertyDescriptor;
  Object.defineProperty(arrayPrototypeDescriptors, String(index), {
    configurable: false,
    enumerable: true,
    value: descriptor,
    writable: false,
  });
}
Object.setPrototypeOf(arrayPrototypeKeys, null);
Object.setPrototypeOf(arrayPrototypeDescriptors, null);
Object.freeze(arrayPrototypeKeys);
Object.freeze(arrayPrototypeDescriptors);

function descriptorsMatch(
  expected: PropertyDescriptor,
  actual: PropertyDescriptor,
): boolean {
  if (
    expected.configurable !== actual.configurable ||
    expected.enumerable !== actual.enumerable
  ) {
    return false;
  }

  const expectedIsData = "value" in expected;
  const actualIsData = "value" in actual;
  if (expectedIsData !== actualIsData) {
    return false;
  }
  if (expectedIsData && actualIsData) {
    return (
      expected.writable === actual.writable &&
      Object.is(expected.value, actual.value)
    );
  }
  return (
    Object.is(expected.get, actual.get) && Object.is(expected.set, actual.set)
  );
}

function assertArrayPrototypeIntegrity(): void {
  const currentKeys = Reflect.ownKeys(Array.prototype);
  if (currentKeys.length !== arrayPrototypeKeys.length) {
    throw new TypeError("Array.prototype was modified after initialization");
  }

  for (let index = 0; index < currentKeys.length; index += 1) {
    const currentKey = currentKeys[index] as PropertyKey;
    const expectedKey = arrayPrototypeKeys[index] as PropertyKey;
    const expectedDescriptor = arrayPrototypeDescriptors[
      index
    ] as PropertyDescriptor;
    if (currentKey !== expectedKey) {
      throw new TypeError("Array.prototype was modified after initialization");
    }
    const currentDescriptor = Object.getOwnPropertyDescriptor(
      Array.prototype,
      currentKey,
    ) as PropertyDescriptor;
    if (!descriptorsMatch(expectedDescriptor, currentDescriptor)) {
      throw new TypeError("Array.prototype was modified after initialization");
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
  assertArrayPrototypeIntegrity();
  return contextFrameV1Schema.parse(snapshotJsonWire(input));
}

export function normalizeContextQueryV1(input: unknown): ContextQueryV1 {
  assertArrayPrototypeIntegrity();
  return contextQueryV1Schema.parse(snapshotJsonWire(input));
}
