import {
  budgetTokens,
  PROTOCOL_VERSION as SDK_PROTOCOL_VERSION,
  type ContextFrame as SdkContextFrame,
  type ContextQuery as SdkContextQuery,
} from "@contextgraphprotocol/typescript-sdk";
import { z } from "zod";
import { snapshotJsonWire } from "./json-wire";

// The canonical SDK is the single source of the protocol version string; a
// divergence between this package and the SDK cannot compile.
export const CONTEXTGRAPH_PROTOCOL_VERSION = SDK_PROTOCOL_VERSION;
export const CONTEXTGRAPH_FIXTURE_PROFILE_VERSION = "1.1.0" as const;

const intrinsicMathFround = Math.fround;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicObjectIs = Object.is;
const u32Schema = z
  .number()
  .int()
  .min(0)
  .max(0xffff_ffff)
  .refine((value) => !intrinsicObjectIs(value, -0), {
    message: "u32 value must not be negative zero",
  });
const finiteNumberSchema = z.number().finite();
const f32NumberSchema = finiteNumberSchema.refine(
  (value) => intrinsicNumberIsFinite(intrinsicMathFround(value)),
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
      intrinsicObjectIs(expected.value, actual.value)
    );
  }
  return (
    intrinsicObjectIs(expected.get, actual.get) &&
    intrinsicObjectIs(expected.set, actual.set)
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

const contextRepresentationV1Schema = z.enum(["full", "compact", "reference"]);

const contextContentFidelityV1Schema = z.enum([
  "exact",
  "normalized",
  "summarized",
  "omitted",
]);

const contextInlineContentRequirementV1Schema = z.enum([
  "required",
  "resolvable_reference_allowed",
]);

const contextContentRefV1Schema = z
  .object({
    provider_id: z.string(),
    uri: z.string(),
    expires_at: z.string().optional(),
  })
  .strict();

const contextTransformV1Schema = z
  .object({
    method: z.string(),
    implementation: z.string(),
    version: z.string(),
  })
  .strict();

// The representation family (`representation`, `content_fidelity`,
// `content_ref`, `transform`, and the fidelity/tokenizer fields) is optional
// with no `.default()`: materializing one would change the normalized bytes of
// every pinned golden fixture. A frame with no `representation` is a `full`
// frame — that default is applied by the invariants below, not written into
// the output.
//
// `provenance` and `relations` are the deliberate exception. They DO default
// to `[]`, and the pinned fixtures expect those empty arrays to appear in the
// normalized output (see `minimal_frame` in `context-frame.valid.json`).
const contextFrameObjectV1Schema = z
  .object({
    id: z.string(),
    kind: contextFrameKindV1Schema,
    title: z.string(),
    content: z.string().optional(),
    content_digest: z.string().optional(),
    uri: z.string().optional(),
    representation: contextRepresentationV1Schema.optional(),
    content_fidelity: contextContentFidelityV1Schema.optional(),
    canonical_content_hash: z.string().optional(),
    content_ref: contextContentRefV1Schema.optional(),
    transform: contextTransformV1Schema.optional(),
    minimum_content_fidelity: contextContentFidelityV1Schema.optional(),
    inline_content_requirement:
      contextInlineContentRequirementV1Schema.optional(),
    score: finiteNumberSchema.min(0).max(1),
    token_cost: u32Schema,
    canonical_token_cost: u32Schema.optional(),
    tokenizer_ref: z.string().optional(),
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

// Representation invariants, mirrored from `contextgraph-types`'
// `ContextFrame::representation_invariants` (messages kept byte-identical so
// evidence reads the same on both sides of the protocol).
const contextFrameV1Schema = contextFrameObjectV1Schema.superRefine(
  (frame, ctx) => {
    const addIssue = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });
    };
    const representation = frame.representation ?? "full";
    if (representation === "full") {
      if (frame.content === undefined) {
        addIssue("content", "full frame requires inline content");
      }
      return;
    }
    if (representation === "compact") {
      if (frame.content === undefined) {
        addIssue("content", "compact frame requires inline content");
      }
      if (frame.content_digest === undefined) {
        addIssue(
          "content_digest",
          "compact frame requires an inline content hash (content_digest)",
        );
      }
      if (frame.canonical_content_hash === undefined) {
        addIssue(
          "canonical_content_hash",
          "compact frame requires canonical_content_hash",
        );
      }
      if (frame.transform === undefined) {
        addIssue("transform", "compact frame requires a transform identity");
      }
      if (frame.content_ref === undefined) {
        addIssue("content_ref", "compact frame requires content_ref");
      }
      return;
    }
    // "Never encode a reference as content: ''" — any inline content, empty
    // or not, is a violation.
    if (frame.content !== undefined) {
      addIssue("content", "reference frame must not carry inline content");
    }
    if (frame.content_ref === undefined) {
      addIssue("content_ref", "reference frame requires content_ref");
    }
    if (frame.canonical_content_hash === undefined) {
      addIssue(
        "canonical_content_hash",
        "reference frame requires canonical_content_hash",
      );
    }
    if (frame.content_digest !== undefined) {
      addIssue(
        "content_digest",
        "reference frame must omit the inline content hash (content_digest)",
      );
    }
    if (frame.transform !== undefined) {
      addIssue("transform", "reference frame must omit transform");
    }
  },
);

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
    representation_preferences: z
      .array(contextRepresentationV1Schema)
      .optional(),
  })
  .strict();

export type ContextFrameKindV1 = z.infer<typeof contextFrameKindV1Schema>;
export type ContextProvenanceV1 = z.infer<typeof contextProvenanceV1Schema>;
export type ContextFrameEmbeddingV1 = z.infer<
  typeof contextFrameEmbeddingV1Schema
>;
export type ContextRelationV1 = z.infer<typeof contextRelationV1Schema>;
export type ContextRepresentationV1 = z.infer<
  typeof contextRepresentationV1Schema
>;
export type ContextContentFidelityV1 = z.infer<
  typeof contextContentFidelityV1Schema
>;
export type ContextInlineContentRequirementV1 = z.infer<
  typeof contextInlineContentRequirementV1Schema
>;
export type ContextContentRefV1 = z.infer<typeof contextContentRefV1Schema>;
export type ContextTransformV1 = z.infer<typeof contextTransformV1Schema>;
export type ContextFrameV1 = z.infer<typeof contextFrameV1Schema>;
export type ContextQueryV1 = z.infer<typeof contextQueryV1Schema>;

// ─── Compile-time drift checks against the canonical SDK wire types ─────────
// `@contextgraphprotocol/typescript-sdk` is the canonical source of the CGP
// wire contract (ADR-036). These assertions fail the typecheck when the SDK
// adds a wire field this schema does not model, or when a modeled field's
// declared type stops being assignable to the SDK's.
//
// What they do NOT catch: a union the SDK *widens*. If `FrameKind` gains a
// variant, the narrower local enum is still assignable to the wider SDK one,
// both assertions still pass, and this package silently rejects a frame the
// protocol now allows. Nothing here or in `contextgraph.test.ts` currently
// compares the enum members themselves against the SDK's.
type AssertNever<T extends never> = T;
type AssertAssignable<T extends Target, Target> = T;

export type FrameSchemaCoversEverySdkField = AssertNever<
  Exclude<keyof SdkContextFrame, keyof ContextFrameV1>
>;
export type QuerySchemaCoversEverySdkField = AssertNever<
  Exclude<keyof SdkContextQuery, keyof ContextQueryV1>
>;
export type FrameSchemaProducesSdkFrames = AssertAssignable<
  ContextFrameV1,
  SdkContextFrame
>;
export type QuerySchemaProducesSdkQueries = AssertAssignable<
  ContextQueryV1,
  SdkContextQuery
>;

export function normalizeContextFrameV1(input: unknown): ContextFrameV1 {
  assertIntrinsicIntegrity();
  return contextFrameV1Schema.parse(snapshotJsonWire(input));
}

export function normalizeContextQueryV1(input: unknown): ContextQueryV1 {
  assertIntrinsicIntegrity();
  return contextQueryV1Schema.parse(snapshotJsonWire(input));
}

// ─── Canonical token accounting (`SPEC.md` §B3) ─────────────────────────────
// The cost arithmetic comes from the canonical SDK (`budgetTokens`), not a
// local re-derivation: `ceil(utf8_byte_length(content) / 4)`, and a frame
// with no inline content costs 0. This check is separate from
// `normalizeContextFrameV1` because some pinned golden fixtures carry a
// `token_cost` that does not match their content. Parsing must still accept
// those fixtures, so the match check is a separate predicate, not a parse gate.

/** The canonical budget-token cost of this frame's inline content. */
export function expectedInlineTokenCostV1(
  frame: Pick<ContextFrameV1, "content">,
): number {
  assertIntrinsicIntegrity();
  return budgetTokens(frame.content);
}

/** Whether `token_cost` matches the canonical count for this frame's content. */
export function declaresHonestTokenCostV1(
  frame: Pick<ContextFrameV1, "content" | "token_cost">,
): boolean {
  assertIntrinsicIntegrity();
  return frame.token_cost === budgetTokens(frame.content);
}

// ─── Temporal profile (`SPEC.md` §F4) ───────────────────────────────────────
// One spelling per instant: RFC 3339, UTC only (`Z` suffix), optional
// non-empty fractional seconds, leap second 60 permitted, real calendar days.
// Mirrored from `contextgraph-types`' `is_protocol_timestamp`.

export const CONTEXTGRAPH_TEMPORAL_FIELDS = [
  "valid_from",
  "valid_to",
  "recorded_at",
] as const;
export type ContextTemporalFieldV1 =
  (typeof CONTEXTGRAPH_TEMPORAL_FIELDS)[number];

function digitAt(value: string, index: number): number | undefined {
  const code = value.charCodeAt(index);
  return code >= 48 && code <= 57 ? code - 48 : undefined;
}

function twoDigitsAt(value: string, index: number): number | undefined {
  const tens = digitAt(value, index);
  const ones = digitAt(value, index + 1);
  if (tens === undefined || ones === undefined) {
    return undefined;
  }
  return tens * 10 + ones;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/** Whether `value` is in the protocol's timestamp profile (`SPEC.md` §F4). */
export function isProtocolTimestampV1(value: string): boolean {
  assertIntrinsicIntegrity();
  // Shortest legal form is "YYYY-MM-DDTHH:MM:SSZ" = 20 characters.
  if (value.length < 20) {
    return false;
  }
  if (
    value[4] !== "-" ||
    value[7] !== "-" ||
    value[10] !== "T" ||
    value[13] !== ":" ||
    value[16] !== ":"
  ) {
    return false;
  }
  const yearDigits = [
    digitAt(value, 0),
    digitAt(value, 1),
    digitAt(value, 2),
    digitAt(value, 3),
  ];
  if (yearDigits.some((digit) => digit === undefined)) {
    return false;
  }
  const year =
    (yearDigits[0] as number) * 1000 +
    (yearDigits[1] as number) * 100 +
    (yearDigits[2] as number) * 10 +
    (yearDigits[3] as number);
  const month = twoDigitsAt(value, 5);
  const day = twoDigitsAt(value, 8);
  const hour = twoDigitsAt(value, 11);
  const minute = twoDigitsAt(value, 14);
  const second = twoDigitsAt(value, 17);
  if (
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return false;
  }
  // RFC 3339 permits second 60 to represent a leap second.
  if (hour > 23 || minute > 59 || second > 60) {
    return false;
  }
  const rest = value.slice(19);
  if (rest === "Z") {
    return true;
  }
  // Fractional seconds: a dot, at least one digit, then Z.
  if (rest[0] !== "." || rest[rest.length - 1] !== "Z" || rest.length < 3) {
    return false;
  }
  for (let index = 1; index < rest.length - 1; index += 1) {
    if (digitAt(rest, index) === undefined) {
      return false;
    }
  }
  return true;
}

/** The names of any temporal fields outside the protocol's timestamp profile. */
export function invalidTemporalFieldsV1(
  frame: Pick<ContextFrameV1, ContextTemporalFieldV1>,
): ContextTemporalFieldV1[] {
  assertIntrinsicIntegrity();
  const invalid: ContextTemporalFieldV1[] = [];
  for (const field of CONTEXTGRAPH_TEMPORAL_FIELDS) {
    const value = frame[field];
    if (value !== undefined && !isProtocolTimestampV1(value)) {
      invalid.push(field);
    }
  }
  return invalid;
}

/** Whether every temporal field present on this frame is well-formed. */
export function hasValidTemporalFieldsV1(
  frame: Pick<ContextFrameV1, ContextTemporalFieldV1>,
): boolean {
  return invalidTemporalFieldsV1(frame).length === 0;
}
