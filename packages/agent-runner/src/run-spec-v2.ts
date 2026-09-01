/**
 * `RunSpecV2` — the trusted admission contract for a governed durable run
 * (docs/specs/run-evidence-ingress/spec.md, "Trusted run and attempt
 * identity"; 02-run-attempt-foundation-plan.md, Task 1).
 *
 * A `RunSpecV2` is the immutable admission record: who delegated the run,
 * which agent version acts, which authorization ceiling was pinned, which
 * repository snapshot was resolved, and what retention policy governs the
 * evidence. It is constructed ONLY by trusted server code. A request body may
 * influence the goal and a few advisory preferences; it can never set an
 * identity or authority field. That is the whole point of this module, and it
 * is enforced three independent ways (see `buildTrustedRunSpecV2`).
 *
 * Two entry points, deliberately distinct:
 *
 *   - `parseRunSpecV2(raw)` re-validates data that is ALREADY persisted and
 *     trusted — the worker hydrating a claimed run, the finalizer reading a
 *     sealed attempt. It admits nothing new; it proves the stored bytes still
 *     satisfy the contract.
 *   - `buildTrustedRunSpecV2(trusted, influence)` mints a NEW spec from
 *     server-resolved values plus a separately-validated caller-influence
 *     object.
 *
 * Every object schema is `.strict()`. An unknown key is a rejection, never a
 * silent strip: a stripped key would let a forged field disappear into a
 * digest that then "verifies", which is exactly the failure this contract
 * exists to prevent.
 *
 * ── Identifier kinds ────────────────────────────────────────────────────────
 *
 * The run row stores typed security columns beside the serialized spec so
 * security queries never parse JSON, and the worker compares the two before
 * materializing a tool (`compareRunRowIdentity`). For that comparison to be
 * direct equality rather than a join, each spec field holds the SAME kind of
 * value as the column it is compared against:
 *
 *   - `*_public_id` fields hold prefixed public ids (`rpb_…`) — the values the
 *     wire and replay boundaries use.
 *   - `retention_policy_id` holds a public id despite the `_id` name (the plan
 *     calls it "retention-policy public ID"). No prefix is reserved for it
 *     yet, so it is validated as a well-formed public id that is NOT one of
 *     the ten reserved prefixes.
 *   - Every other `*_id` is an internal UUID foreign key: principals, agent,
 *     agent version, authorization snapshot, connection, environment, parent
 *     run. Internal UUIDs stay internal — none of these fields ever appears in
 *     a request body or a public API response.
 *   - `provider_repository_id` is an opaque provider-assigned string (GitHub's
 *     immutable repository id). Not a UUID, not an Oxagen public id.
 *
 * Confusion in either direction is a rejection: a public id where a UUID
 * belongs, or a UUID where a public id belongs.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CanonicalJsonError,
  RunSpecDigestMismatchError,
  RunSpecIdentityMismatchError,
  RunSpecValidationError,
  UntrustedRunSpecFieldError,
  type RunIdentityMismatch,
  type RunSpecIssue,
} from "./run-errors";

// ── Canonical JSON + digest primitives ──────────────────────────────────────

/**
 * DELIBERATELY LOCAL AND MINIMAL — and now a KNOWN DUPLICATE.
 *
 * `@oxagen/run-evidence` has since landed with its own JCS/RFC-8785 helpers
 * (`jcsBytes`, `digestJcs`, built on the `canonicalize` package). This module
 * still carries its own copy: agent-runner takes no dependency on that package,
 * and consolidating the two is a dependency and digest-compatibility change,
 * not a comment fix. Until that consolidation is proven vector by vector,
 * treat these as two implementations that MUST agree, and change neither
 * casually.
 *
 * The surface here is intentionally small and RFC 8785-compatible — object
 * keys sorted by UTF-16 code unit, no insignificant whitespace, exact UTF-8
 * bytes, `sha256:<64 lowercase hex>` at every boundary. The empty-object vector
 * is pinned in run-spec-v2.test.ts so any drift fails a test rather than a
 * production manifest.
 *
 * Two deliberate narrowings versus full JCS, both fail-closed: only safe
 * integers are accepted (this implementation has no ES6 float-serialization
 * step, so a float must never enter a digest input here), and non-JSON values
 * are refused rather than coerced. `@oxagen/run-evidence` DOES serialize
 * floats, so the two agree only on the values this one accepts — which is
 * exactly why the consolidation needs vectors, not an import swap.
 */
export function canonicalJson(value: unknown): string {
  return writeCanonical(value, "");
}

function writeCanonical(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError(
          path,
          "only safe integers may be canonicalized",
        );
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalJsonError(path, `unsupported type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => {
      if (item === undefined) {
        // JSON.stringify would coerce this to `null` and silently change the
        // document. A digest over a silently-changed document is worthless.
        throw new CanonicalJsonError(join(path, String(index)), "undefined");
      }
      return writeCanonical(item, join(path, String(index)));
    });
    return `[${items.join(",")}]`;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(
      path,
      `non-plain object (${value.constructor?.name ?? "unknown"})`,
    );
  }

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  // Default Array#sort compares UTF-16 code units — exactly RFC 8785's rule.
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    // An explicitly-undefined key and an absent key are the same JSON
    // document, so both must canonicalize identically.
    if (item === undefined) continue;
    parts.push(
      `${JSON.stringify(key)}:${writeCanonical(item, join(path, key))}`,
    );
  }
  return `{${parts.join(",")}}`;
}

function join(path: string, segment: string): string {
  return path ? `${path}.${segment}` : segment;
}

/** `sha256:<64 lowercase hex>` over the RFC 8785 canonical bytes of `value`. */
export function digestOfCanonicalJson(value: unknown): Sha256Digest {
  const hex = createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
  return `sha256:${hex}` as Sha256Digest;
}

// ── Primitive schemas ───────────────────────────────────────────────────────

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** Canonical lowercase UUID. Uppercase and dash-stripped forms are rejected. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A non-negative integer with no leading zeros — a Postgres bigint counter. */
const DECIMAL_GENERATION_RE = /^(?:0|[1-9][0-9]*)$/;
/** Git SHA-1 object id. An unresolved ref or a `sha256:` digest is not one. */
const GIT_OBJECT_ID_RE = /^[0-9a-f]{40}$/;
/** Exact semantic version — no ranges, wildcards, or `latest` aliases. */
const EXACT_SEMVER_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** RFC 3339 instant with an explicit zone. A naive timestamp is ambiguous. */
const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/** `<prefix>_<16..32 lowercase hex>` — every public id minted in this repo. */
const PUBLIC_ID_SUFFIX_RE = /^[0-9a-f]{16,32}$/;

/**
 * Algorithm-qualified sha256 digest. Every digest crossing a boundary in this
 * contract is this shape — a bare hex string is rejected so a caller can never
 * substitute a weaker algorithm's output.
 */
export const sha256DigestSchema = z
  .string()
  .regex(SHA256_DIGEST_RE, "expected sha256:<64 lowercase hex>")
  .brand<"Sha256Digest">();
export type Sha256Digest = z.output<typeof sha256DigestSchema>;

/**
 * A deny-generation counter as an exact decimal string. Postgres assigns these
 * as `bigint`; a JS `number` silently loses precision past 2^53, so they cross
 * every boundary as strings and are compared as strings.
 */
export const decimalGenerationSchema = z
  .string()
  .regex(
    DECIMAL_GENERATION_RE,
    "expected a non-negative decimal integer string",
  )
  .brand<"DecimalGeneration">();
export type DecimalGeneration = z.output<typeof decimalGenerationSchema>;

const uuidSchema = z
  .string()
  .regex(UUID_RE, "expected a lowercase canonical UUID, not a public id");

const gitObjectIdSchema = z
  .string()
  .regex(GIT_OBJECT_ID_RE, "expected a 40-character lowercase git object id");

const rfc3339Schema = z
  .string()
  .regex(RFC3339_RE, "expected an RFC 3339 timestamp with an explicit zone")
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "expected a real instant",
  );

/**
 * Public id prefixes reserved by the run-evidence domain. Reserved means two
 * things: a field typed to one of these accepts only that prefix, and a field
 * typed to some OTHER public id (the retention policy, today) rejects all ten
 * so an id of one kind can never be passed where another belongs.
 */
export const RESERVED_PUBLIC_ID_PREFIXES = Object.freeze({
  run: "arun_",
  attempt: "arat_",
  repositoryBinding: "rpb_",
  authorizationSnapshot: "ras_",
  authorizationDecision: "azd_",
  finalizationGrant: "afg_",
  evidenceBlob: "evb_",
  pathLocator: "rpl_",
  verificationKey: "revk_",
  providerObservation: "rpo_",
} as const);

export type ReservedPublicIdKind = keyof typeof RESERVED_PUBLIC_ID_PREFIXES;

const RESERVED_PREFIX_LIST: readonly string[] = Object.freeze(
  Object.values(RESERVED_PUBLIC_ID_PREFIXES),
);

function splitPublicId(
  value: string,
): { prefix: string; suffix: string } | null {
  const underscore = value.indexOf("_");
  if (underscore <= 0) return null;
  return {
    prefix: value.slice(0, underscore + 1),
    suffix: value.slice(underscore + 1),
  };
}

/** A public id bearing exactly `prefix`, e.g. `rpb_0f3c…`. */
function publicIdSchema(prefix: string, label: string) {
  return z.string().refine((value) => {
    const parts = splitPublicId(value);
    return (
      parts !== null &&
      parts.prefix === prefix &&
      PUBLIC_ID_SUFFIX_RE.test(parts.suffix)
    );
  }, `expected a ${label} public id (${prefix}<16-32 lowercase hex>)`);
}

/**
 * A well-formed public id that is NOT one of the reserved run-evidence
 * prefixes. Used for the retention-policy version id: the plan pins it as a
 * public id, but Task 2 has not yet reserved a prefix for it, so this rejects
 * both an internal UUID and any reserved-domain id rather than inventing a
 * prefix that could collide with the migration.
 */
const nonReservedPublicIdSchema = z.string().refine((value) => {
  const parts = splitPublicId(value);
  return (
    parts !== null &&
    !RESERVED_PREFIX_LIST.includes(parts.prefix) &&
    PUBLIC_ID_SUFFIX_RE.test(parts.suffix)
  );
}, "expected a non-reserved public id (<prefix>_<16-32 lowercase hex>)");

export const repositoryBindingPublicIdSchema = publicIdSchema(
  RESERVED_PUBLIC_ID_PREFIXES.repositoryBinding,
  "repository binding",
).brand<"RepositoryBindingPublicId">();
export type RepositoryBindingPublicId = z.output<
  typeof repositoryBindingPublicIdSchema
>;

export const retentionPolicyPublicIdSchema =
  nonReservedPublicIdSchema.brand<"RetentionPolicyPublicId">();
export type RetentionPolicyPublicId = z.output<
  typeof retentionPolicyPublicIdSchema
>;

// ── Admission ceilings and enumerations ─────────────────────────────────────

/**
 * Engines admissible today. Stella is the only one: the TypeScript step loop
 * it replaced has been deleted, so a spec naming `ts` fails admission rather
 * than being resolved at claim time. `RETIRED_ENGINES` in
 * `stella/engine-choice.ts` is what turns that failure into a sentence saying
 * the engine was removed, instead of "unknown engine".
 */
export const RUN_ENGINES = ["stella"] as const;

/** Repository providers admissible today. The first slice is GitHub-only. */
export const REPOSITORY_PROVIDERS = ["github"] as const;

/** Risk ceiling values — mirrors the agent_tools risk_level CHECK constraint. */
export const TOOL_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;

/**
 * Hard admission ceiling on the trusted per-run attempt cap. The run row pins
 * its own `max_attempts` inside this bound; run-store's `MAX_RUN_ATTEMPTS` is
 * the separate V1 global default and does not constrain a V2 run.
 */
export const MAX_RUN_ATTEMPTS_CEILING = 10;

/** Hard admission ceiling on engine steps (the engine default is 256). */
export const MAX_RUN_STEPS_CEILING = 4096;

const goalSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => value.trim().length > 0, "expected a non-blank goal");

const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    "expected a git ref with no whitespace or leading dash",
  )
  .refine((value) => !value.includes(".."), "expected a ref with no '..'");

const capabilityNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.]*$/, "expected a lowercase capability name");

const contextProviderIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/, "expected a lowercase context provider id");

/**
 * A bounded array with no duplicate entries. `min`/`max` are applied before
 * the uniqueness refinement — `.refine()` yields a ZodEffects, which no longer
 * exposes the array's own length methods.
 */
function uniqueArray<T extends z.ZodTypeAny>(item: T, max: number, min = 0) {
  return z
    .array(item)
    .min(min)
    .max(max)
    .refine(
      (values) => new Set(values as unknown[]).size === values.length,
      "expected unique entries",
    );
}

// ── Section schemas ─────────────────────────────────────────────────────────

export const enginePolicySchema = z
  .object({
    requested_engine: z.enum(RUN_ENGINES),
    allowed_engine_versions: uniqueArray(
      z.string().regex(EXACT_SEMVER_RE, "expected an exact semantic version"),
      32,
      1,
    ),
    model_policy_ref: z.string().min(1).max(128),
    max_steps: z.number().int().min(1).max(MAX_RUN_STEPS_CEILING),
    max_attempts: z.number().int().min(1).max(MAX_RUN_ATTEMPTS_CEILING),
  })
  .strict();

export const actorBindingSchema = z
  .object({
    initiating_principal_id: uuidSchema,
    agent_principal_id: uuidSchema,
    agent_id: uuidSchema,
    agent_version_id: uuidSchema,
    agent_version_checksum: sha256DigestSchema,
    parent_run_id: uuidSchema.optional(),
  })
  .strict();

export const denyGenerationVectorSchema = z
  .object({
    org: decimalGenerationSchema,
    workspace: decimalGenerationSchema,
  })
  .strict();

export const authorizationSnapshotRefSchema = z
  .object({
    snapshot_id: uuidSchema,
    snapshot_digest: sha256DigestSchema,
    grant_ceiling_digest: sha256DigestSchema,
    deny_generation_at_admission: denyGenerationVectorSchema,
    resolved_at: rfc3339Schema,
  })
  .strict();
export type AuthorizationSnapshotRef = z.output<
  typeof authorizationSnapshotRefSchema
>;

export const repositoryBindingSchema = z
  .object({
    repository_binding_public_id: repositoryBindingPublicIdSchema,
    provider: z.enum(REPOSITORY_PROVIDERS),
    provider_repository_id: z.string().min(1).max(256),
    connection_id: uuidSchema,
    configured_default_ref: gitRefSchema,
    base_commit_sha: gitObjectIdSchema,
    base_tree_sha: gitObjectIdSchema,
  })
  .strict();
export type RepositoryBinding = z.output<typeof repositoryBindingSchema>;

export const workspacePolicySchema = z
  .object({
    // Governed agent edits are sandbox-only. `true` is a literal, not a
    // default: an admission path that cannot create a sandbox must fail with a
    // typed unavailable error, never admit an unsandboxed run.
    sandbox_required: z.literal(true),
    environment_id: uuidSchema.optional(),
  })
  .strict();

export const contextPolicySchema = z
  .object({
    provider_allowlist: uniqueArray(contextProviderIdSchema, 64),
    max_frames: z.number().int().min(0).max(4096),
    max_tokens: z.number().int().min(0).max(8_000_000),
    // Both id and digest are pinned so a producer cannot upgrade itself from
    // digest-only to exact retention by pointing at a mutable "current" policy.
    retention_policy_id: retentionPolicyPublicIdSchema,
    retention_policy_digest: sha256DigestSchema,
  })
  .strict();

export const toolPolicySchema = z
  .object({
    allowlist: uniqueArray(capabilityNameSchema, 256),
    risk_ceiling: z.enum(TOOL_RISK_LEVELS),
  })
  .strict();

export const outputPolicySchema = z
  .object({
    target_branch: gitRefSchema.optional(),
    open_pull_request: z.literal(true),
  })
  .strict();

const commonSpecShape = {
  version: z.literal(2),
  goal: goalSchema,
  engine_policy: enginePolicySchema,
  actor_binding: actorBindingSchema,
  authorization_snapshot_ref: authorizationSnapshotRefSchema,
  workspace_policy: workspacePolicySchema,
  context_policy: contextPolicySchema,
  tool_policy: toolPolicySchema,
};

/**
 * A run that frames context and calls tools but binds no repository. Because
 * the schema is `.strict()`, a `repository_binding` or `output_policy` on a
 * general run is an unknown key — a general run can never acquire repository
 * authority without being labelled `repo_edit`.
 */
export const generalRunSpecV2Schema = z
  .object({ ...commonSpecShape, run_kind: z.literal("general") })
  .strict();

/** A sandbox-backed repository edit. Every repository field is pinned. */
export const repoEditRunSpecV2Schema = z
  .object({
    ...commonSpecShape,
    run_kind: z.literal("repo_edit"),
    repository_binding: repositoryBindingSchema,
    output_policy: outputPolicySchema,
  })
  .strict();

export const runSpecV2Schema = z.discriminatedUnion("run_kind", [
  generalRunSpecV2Schema,
  repoEditRunSpecV2Schema,
]);

export type GeneralRunSpecV2 = z.output<typeof generalRunSpecV2Schema>;
export type RepoEditRunSpecV2 = z.output<typeof repoEditRunSpecV2Schema>;
export type RunSpecV2 = z.output<typeof runSpecV2Schema>;
/** The unbranded shape a trusted resolver hands in, before validation. */
export type RunSpecV2Input = z.input<typeof runSpecV2Schema>;

// ── Caller influence — the trusted-field boundary ───────────────────────────

/**
 * Every section of `RunSpecV2` a caller may not supply. Exported so the
 * runtime guard, the compile-time type, and the tests all read from ONE list —
 * a section added to the spec without being added here would otherwise become
 * silently caller-settable.
 */
export const TRUSTED_RUN_SPEC_SECTIONS = [
  "version",
  "run_kind",
  "engine_policy",
  "actor_binding",
  "authorization_snapshot_ref",
  "repository_binding",
  "workspace_policy",
  "context_policy",
  "tool_policy",
  "output_policy",
] as const;

export type TrustedRunSpecSection = (typeof TRUSTED_RUN_SPEC_SECTIONS)[number];

/**
 * Advisory hints a request body may carry. These are inputs to trusted
 * resolution — the admission path MAY consult them when it resolves the engine
 * and step budget, subject to policy — but they are never copied into the
 * spec. `buildTrustedRunSpecV2` reads `goal` and nothing else.
 */
export const callerRunPreferencesSchema = z
  .object({
    requested_engine: z.string().min(1).max(64).optional(),
    max_steps: z.number().int().min(1).max(MAX_RUN_STEPS_CEILING).optional(),
  })
  .strict();

export const callerRunInfluenceSchema = z
  .object({
    goal: goalSchema,
    preferences: callerRunPreferencesSchema.optional(),
  })
  .strict();

/**
 * The caller-controlled half of a run request, kept as a SEPARATE object from
 * every trusted section so the two can never be merged by accident.
 *
 * The `{ [K in TrustedRunSpecSection]?: never }` intersection makes passing a
 * trusted section a compile error. That guarantee erodes at an `unknown`-typed
 * transport boundary, which is why `buildTrustedRunSpecV2` also enforces it at
 * runtime.
 */
export type CallerRunInfluence = {
  goal: string;
  preferences?: z.input<typeof callerRunPreferencesSchema>;
} & { [K in TrustedRunSpecSection]?: never };

export type ParsedCallerRunInfluence = z.output<
  typeof callerRunInfluenceSchema
>;

/** Distributes `Omit` across a union so each member keeps its own shape. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * The trusted half: every spec section except the two the server owns
 * unconditionally. `version` is not settable (the builder pins 2) and `goal`
 * comes from caller influence, so neither appears here.
 */
export type TrustedRunSpecV2Input = DistributiveOmit<
  RunSpecV2Input,
  "version" | "goal"
>;

// ── Parsing ─────────────────────────────────────────────────────────────────

function toIssues(error: z.ZodError): RunSpecIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
  message: string,
): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new RunSpecValidationError(message, toIssues(result.error));
  }
  return result.data as z.output<T>;
}

/**
 * Validate persisted trusted data. Used by the worker hydrating a claimed run
 * and by the finalizer reading a sealed attempt — it proves the stored bytes
 * still satisfy the contract, and admits nothing.
 */
export function parseRunSpecV2(raw: unknown): RunSpecV2 {
  return parseOrThrow(runSpecV2Schema, raw, "Invalid RunSpecV2");
}

/** Validate the caller-controlled half of a run request. */
export function parseCallerRunInfluence(
  raw: unknown,
): ParsedCallerRunInfluence {
  return parseOrThrow(
    callerRunInfluenceSchema,
    raw,
    "Invalid caller run influence",
  );
}

/** Validate a `sha256:<64 lowercase hex>` digest at a boundary. */
export function assertSha256Digest(value: unknown): Sha256Digest {
  return parseOrThrow(sha256DigestSchema, value, "Invalid sha256 digest");
}

/** Validate a decimal deny-generation counter at a boundary. */
export function assertDecimalGeneration(value: unknown): DecimalGeneration {
  return parseOrThrow(
    decimalGenerationSchema,
    value,
    "Invalid deny generation",
  );
}

// ── Trusted construction ────────────────────────────────────────────────────

/**
 * Mint a `RunSpecV2` from server-resolved values plus a caller's goal.
 *
 * Trusted-field injection is structurally impossible here, three ways:
 *
 *  1. `trusted` and `influence` are SEPARATE PARAMETERS. There is no single
 *     object a caller could over-populate, and no code path spreads
 *     `influence` — the assembled spec picks `goal` by name and copies each
 *     trusted section from `trusted` explicitly.
 *  2. `CallerRunInfluence` intersects `{ [K in TrustedRunSpecSection]?: never }`,
 *     so naming a trusted section on the influence object is a compile error.
 *  3. At runtime, `influence` is checked against `TRUSTED_RUN_SPEC_SECTIONS`
 *     (throwing `UntrustedRunSpecFieldError`) and then parsed by a `.strict()`
 *     schema. Both fire even when the value arrived as `unknown` from a
 *     transport, where the type guarantee is worthless.
 *
 * The assembled object is re-parsed by `runSpecV2Schema` before it is
 * returned, so a caller can never receive an object that would not itself
 * survive `parseRunSpecV2`.
 */
export function buildTrustedRunSpecV2(
  trusted: TrustedRunSpecV2Input,
  influence: CallerRunInfluence,
): RunSpecV2 {
  assertNoTrustedSections(influence);
  const { goal } = parseCallerRunInfluence(influence);

  const source = trusted as Extract<RunSpecV2Input, { run_kind: string }>;
  const base = {
    version: 2 as const,
    run_kind: source.run_kind,
    goal,
    engine_policy: source.engine_policy,
    actor_binding: source.actor_binding,
    authorization_snapshot_ref: source.authorization_snapshot_ref,
    workspace_policy: source.workspace_policy,
    context_policy: source.context_policy,
    tool_policy: source.tool_policy,
  };

  const assembled =
    source.run_kind === "repo_edit"
      ? {
          ...base,
          run_kind: "repo_edit" as const,
          repository_binding: source.repository_binding,
          output_policy: source.output_policy,
        }
      : base;

  return parseRunSpecV2(assembled);
}

function assertNoTrustedSections(influence: CallerRunInfluence): void {
  if (typeof influence !== "object" || influence === null) return;
  const record = influence as Record<string, unknown>;
  const smuggled = TRUSTED_RUN_SPEC_SECTIONS.filter((section) =>
    Object.prototype.hasOwnProperty.call(record, section),
  );
  if (smuggled.length > 0) throw new UntrustedRunSpecFieldError(smuggled);
}

// ── Spec digest ─────────────────────────────────────────────────────────────

/**
 * The canonical spec digest stored on the run row. Computed over the parsed
 * spec, so it is independent of the key order the resolver happened to use and
 * of any whitespace in the persisted JSON column.
 */
export function runSpecV2Digest(spec: RunSpecV2): Sha256Digest {
  return digestOfCanonicalJson(spec);
}

/**
 * Verify a spec against the digest stored beside it. A mismatch means the spec
 * JSON or the digest column was altered after admission; the run must not
 * execute.
 */
export function assertRunSpecV2Digest(
  spec: RunSpecV2,
  storedDigest: unknown,
): void {
  const expected = assertSha256Digest(storedDigest);
  const actual = runSpecV2Digest(spec);
  if (expected !== actual) {
    throw new RunSpecDigestMismatchError(expected, actual);
  }
}

// ── Row / spec identity ─────────────────────────────────────────────────────

/**
 * The typed security columns on `agent.agent_runs`, projected for comparison
 * against the serialized spec. Repository columns are nullable because a
 * `general` run has no repository binding; for such a run they MUST be null,
 * and `compareRunRowIdentity` reports a non-null value as a mismatch.
 *
 * This shape is the contract Task 2's migration has to match — a column that
 * stores a different kind of value than the spec field it mirrors (a UUID
 * where the spec holds an `rpb_` public id, say) would make this comparison
 * structurally impossible.
 */
export interface RunRowIdentity {
  spec_version: number;
  run_kind: string;
  spec_digest: string;
  initiating_principal_id: string;
  agent_principal_id: string;
  agent_id: string;
  agent_version_id: string;
  agent_version_checksum: string;
  authorization_snapshot_id: string;
  parent_run_id: string | null;
  repository_binding_public_id: string | null;
  provider: string | null;
  provider_repository_id: string | null;
  connection_id: string | null;
  configured_default_ref: string | null;
  base_commit_sha: string | null;
  base_tree_sha: string | null;
  retention_policy_id: string;
  retention_policy_digest: string;
  max_attempts: number;
}

export type { RunIdentityMismatch };

/**
 * Compare a run row's typed columns against the serialized spec, field by
 * field. Returns EVERY divergence rather than the first: a partial rewrite is
 * more diagnostic than a single field, and a security event should record the
 * whole picture. An empty array means the row and spec agree.
 *
 * The spec digest is deliberately NOT compared here — that is
 * `assertRunSpecV2Digest`'s job, with its own error type;
 * `assertRunRowMatchesSpec` composes the two in the right order.
 */
export function compareRunRowIdentity(
  row: RunRowIdentity,
  spec: RunSpecV2,
): RunIdentityMismatch[] {
  const repository =
    spec.run_kind === "repo_edit" ? spec.repository_binding : null;
  const expected: Array<[keyof RunRowIdentity, unknown]> = [
    ["spec_version", spec.version],
    ["run_kind", spec.run_kind],
    ["initiating_principal_id", spec.actor_binding.initiating_principal_id],
    ["agent_principal_id", spec.actor_binding.agent_principal_id],
    ["agent_id", spec.actor_binding.agent_id],
    ["agent_version_id", spec.actor_binding.agent_version_id],
    ["agent_version_checksum", spec.actor_binding.agent_version_checksum],
    ["authorization_snapshot_id", spec.authorization_snapshot_ref.snapshot_id],
    ["parent_run_id", spec.actor_binding.parent_run_id ?? null],
    [
      "repository_binding_public_id",
      repository?.repository_binding_public_id ?? null,
    ],
    ["provider", repository?.provider ?? null],
    ["provider_repository_id", repository?.provider_repository_id ?? null],
    ["connection_id", repository?.connection_id ?? null],
    ["configured_default_ref", repository?.configured_default_ref ?? null],
    ["base_commit_sha", repository?.base_commit_sha ?? null],
    ["base_tree_sha", repository?.base_tree_sha ?? null],
    ["retention_policy_id", spec.context_policy.retention_policy_id],
    ["retention_policy_digest", spec.context_policy.retention_policy_digest],
    ["max_attempts", spec.engine_policy.max_attempts],
  ];

  const mismatches: RunIdentityMismatch[] = [];
  for (const [field, specValue] of expected) {
    const rowValue = row[field] ?? null;
    if (rowValue !== (specValue ?? null)) {
      mismatches.push({ field, row: rowValue, spec: specValue ?? null });
    }
  }
  return mismatches;
}

/**
 * Fail closed unless the run row, its stored digest, and the parsed spec all
 * agree. The worker calls this before materializing an engine or tool: either
 * copy could be the tampered one, so neither is trusted when they disagree.
 *
 * Digest first — a spec that does not hash to its stored digest is not a
 * trustworthy basis for a field-by-field comparison.
 */
export function assertRunRowMatchesSpec(
  row: RunRowIdentity,
  spec: RunSpecV2,
): void {
  assertRunSpecV2Digest(spec, row.spec_digest);
  const mismatches = compareRunRowIdentity(row, spec);
  if (mismatches.length > 0) throw new RunSpecIdentityMismatchError(mismatches);
}
