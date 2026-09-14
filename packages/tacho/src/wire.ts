/**
 * The wire documents that cross between a Tacho host and the control plane
 * (spec sections 5.2, 7.1, 7.4 and 3.1 step 3). They live in the leaf package
 * so the daemon, the hook binary, and the control plane validate the same
 * shapes; `packages/oxagen` re-exports these for its contracts.
 */
import { z } from "zod";
import { tachoEventSchema, type TachoEvent } from "./envelope";

export const TACHO_BATCH_SCHEMA = "tacho.batch.v1" as const;
export const TACHO_BUNDLE_SCHEMA = "tacho.bundle.v1" as const;
/**
 * The control-channel document a host posts to acknowledge and fetch
 * commands. v2 acknowledges with the §7.4 status vocabulary and receives
 * commands that carry a delivery mode; a v1 collector's body has no
 * `schema` field and is refused by the strict shape, which is the bump.
 */
export const TACHO_COMMANDS_SCHEMA = "tacho.commands.v2" as const;
export const TACHO_ENROLLMENT_CLAIMS_SCHEMA =
  "oxagen.tacho.host-enrollment.v1" as const;

export const hostEnrollmentIdSchema = z
  .string()
  .regex(/^tch_[a-z0-9]{22}$/, "a host enrollment public id");

export const tachoPlatformSchema = z.enum(["darwin", "linux", "win32"]);
/**
 * The harnesses a host can enroll. Codex CLI's hook surface (events, stdin
 * fields, decision JSON, `hooks.json` shape) mirrors Claude Code's, so it
 * runs through the same `tacho-hook` with a `--harness codex` tag.
 */
export const tachoHarnessSchema = z.enum(["claude-code", "codex"]);
export type TachoHarness = z.infer<typeof tachoHarnessSchema>;
export const tachoHostStatusSchema = z.enum([
  "active",
  "paused",
  "suspended",
  "revoked",
]);
export const tachoBundleModeSchema = z.enum(["observe", "enforce"]);
export const tachoCommandSchema = z.enum([
  "pause",
  "resume",
  "cancel",
  "steer",
  "message",
  "revoke",
  "refresh_bundle",
  "kill",
]);
export type TachoCommand = z.output<typeof tachoCommandSchema>;
/**
 * The closed status vocabulary of Mission Control spec §7.4, shared by
 * commands and messages so one delivery report reads the same whatever was
 * sent. `applied` is the only success status; `cancelled`, `expired` and
 * `failed` are the three undelivered endings.
 */
export const tachoCommandStatusSchema = z.enum([
  "draft",
  "queued",
  "sent",
  "received",
  "acknowledged",
  "applied",
  "cancelled",
  "expired",
  "failed",
]);
export type TachoCommandStatus = z.output<typeof tachoCommandStatusSchema>;
/**
 * The statuses a connection point is in a position to assert about itself.
 * `expired` is Oxagen's clock and `sent` is Oxagen's own act, so neither is
 * a host's to report.
 */
export const tachoCommandAckStatusSchema = tachoCommandStatusSchema.extract([
  "received",
  "acknowledged",
  "applied",
  "failed",
]);
/**
 * Spec §7.3 delivery modes: which model request a steer rides, and whether
 * the current step is cut short to reach one sooner. The hook adapter can
 * carry `next_step` and `turn_boundary`; `interrupt` degrades to `next_step`
 * there and the command records the degradation.
 */
export const tachoDeliveryModeSchema = z.enum([
  "next_step",
  "interrupt",
  "turn_boundary",
]);
export type TachoDeliveryMode = z.output<typeof tachoDeliveryModeSchema>;

export const denyGenerationSchema = z
  .object({
    org: z.number().int().nonnegative(),
    workspace: z.number().int().nonnegative(),
  })
  .strict();

export type DenyGeneration = z.output<typeof denyGenerationSchema>;

/**
 * A command as delivered to a host (spec section 7.4). `requested_mode` and
 * `delivery_mode` are set for the commands that carry prompt content
 * (`steer`, `message`); `degraded_reason` names why the two differ. `reason`
 * is the operator's reason as recorded on the row: the collector shows it at
 * the boundary a pause denies and the model reads it on resume.
 */
export const deliveredCommandSchema = z
  .object({
    id: z.string().min(1),
    command: tachoCommandSchema,
    session_uuid: z.string().uuid().nullable(),
    payload: z.record(z.string(), z.unknown()),
    requested_mode: tachoDeliveryModeSchema.nullable(),
    delivery_mode: tachoDeliveryModeSchema.nullable(),
    degraded_reason: z.string().max(64).nullable(),
    reason: z.string().max(512).nullable(),
    issued_at: z.string(),
    expires_at: z.string().nullable(),
  })
  .strict();

export type DeliveredCommand = z.output<typeof deliveredCommandSchema>;

/** The signed policy bundle a host caches (spec section 7.1). */
export const policyBundleSchema = z
  .object({
    schema: z.literal(TACHO_BUNDLE_SCHEMA),
    version: z.number().int().nonnegative(),
    etag: z.string().min(1),
    issued_at: z.string(),
    expires_at: z.string(),
    host_enrollment_id: hostEnrollmentIdSchema,
    host_status: tachoHostStatusSchema,
    deny_generation: denyGenerationSchema,
    permissions: z
      .object({
        allow: z.array(z.string().max(512)).max(1024),
        deny: z.array(z.string().max(512)).max(1024),
        ask: z.array(z.string().max(512)).max(1024),
      })
      .strict(),
    tools: z.record(
      z.string().max(256),
      z
        .object({
          risk_grade: z.enum(["low", "medium", "high", "critical"]),
          read_only: z.boolean(),
          capability_id: z.string().max(256).optional(),
        })
        .strict(),
    ),
    budget: z
      .object({
        session_limit_usd: z.number().nonnegative().optional(),
        daily_limit_usd: z.number().nonnegative().optional(),
        mode: z.enum(["observed", "enforced"]),
      })
      .strict(),
    context: z.object({ system: z.string().max(16_384).nullable() }).strict(),
    retention: z
      .object({
        mode: z.enum(["digest_only", "content_exact"]),
        classes: z.array(z.string().max(64)).max(32),
      })
      .strict(),
    mode: tachoBundleModeSchema,
    signature: z
      .object({
        key_id: z.string().min(1),
        alg: z.literal("ed25519"),
        sig: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type PolicyBundle = z.output<typeof policyBundleSchema>;

/** The claims the enrollment document is signed over (spec section 5.2). */
export const enrollmentClaimsSchema = z
  .object({
    schema: z.literal(TACHO_ENROLLMENT_CLAIMS_SCHEMA),
    issuer: z.string().min(1),
    audience: z.string().min(1),
    host_enrollment_id: hostEnrollmentIdSchema,
    organization_id: z.string().min(1),
    workspace_id: z.string().min(1),
    agent_key: z.string().min(1),
    ingest_endpoint: z.string().url(),
    bundle_endpoint: z.string().url(),
    commands_endpoint: z.string().url(),
    credential_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    device_key_fingerprint: z.string().min(1),
    harnesses: z.array(tachoHarnessSchema).min(1),
    issued_at_unix_s: z.number().int(),
    expires_at_unix_s: z.number().int(),
  })
  .strict();

export type EnrollmentClaims = z.output<typeof enrollmentClaimsSchema>;

/**
 * The event schema as a plain Zod type: the discriminated union's inferred
 * type is too large for the compiler to serialize into a contract's
 * declaration, and the runtime validation is identical.
 */
export const tachoEventWireSchema: z.ZodType<
  TachoEvent,
  z.ZodTypeDef,
  unknown
> = tachoEventSchema;

export const daemonHealthSchema = z
  .object({
    version: z.string().max(64).optional(),
    uptime_s: z.number().int().nonnegative().optional(),
    spool_depth: z.number().int().nonnegative().optional(),
    spool_oldest_at: z.string().optional(),
    hooks_ok: z.boolean().optional(),
    otel_ok: z.boolean().optional(),
    bundle_etag: z.string().max(128).optional(),
  })
  .strict();

export type DaemonHealth = z.output<typeof daemonHealthSchema>;

export const TACHO_MAX_BATCH = 200;

/** The wire batch a host ships (spec section 3.1 step 3). */
export const tachoBatchSchema = z
  .object({
    schema: z.literal(TACHO_BATCH_SCHEMA),
    host_enrollment_id: hostEnrollmentIdSchema,
    events: z.array(tachoEventWireSchema).min(1).max(TACHO_MAX_BATCH),
    daemon: daemonHealthSchema.optional(),
  })
  .strict();

export type TachoBatch = z.output<typeof tachoBatchSchema>;

/** What every machine-to-machine response carries back (spec section 7.4). */
export const controlEnvelopeSchema = z
  .object({
    host_status: tachoHostStatusSchema,
    deny_generation: denyGenerationSchema,
    bundle_etag: z.string().min(1),
    commands: z.array(deliveredCommandSchema).max(100),
  })
  .strict();

export type ControlEnvelope = z.output<typeof controlEnvelopeSchema>;

/** The ingest response as the host reads it. */
export const ingestResponseSchema = z
  .object({
    accepted: z.number().int().nonnegative(),
    event_ids: z.array(z.string()),
    chain_breaks: z.array(
      z
        .object({
          session_uuid: z.string().uuid(),
          at_seq: z.number().int().nonnegative(),
          reason: z.string(),
        })
        .strict(),
    ),
    control: controlEnvelopeSchema,
  })
  .strict();

export type IngestResponse = z.output<typeof ingestResponseSchema>;

export const bundleResponseSchema = z
  .object({
    not_modified: z.boolean(),
    etag: z.string().min(1),
    bundle: policyBundleSchema.nullable(),
  })
  .strict();

export type BundleResponse = z.output<typeof bundleResponseSchema>;

export const commandAcknowledgementSchema = z
  .object({
    command_id: z.string().min(1),
    status: tachoCommandAckStatusSchema,
    detail: z.string().max(512).optional(),
    applied_at_seq: z.number().int().nonnegative().optional(),
    session_uuid: z.string().uuid().optional(),
  })
  .strict();

export type CommandAcknowledgement = z.output<
  typeof commandAcknowledgementSchema
>;

export const commandsResponseSchema = z
  .object({
    acknowledged: z.number().int().nonnegative(),
    control: controlEnvelopeSchema,
  })
  .strict();

export type CommandsResponse = z.output<typeof commandsResponseSchema>;

/** The enrollment response as the CLI reads it (spec section 5.2). */
export const enrollmentResponseSchema = z
  .object({
    hostEnrollmentId: hostEnrollmentIdSchema,
    agentKey: z.string().min(1),
    apiKeyPublicId: z.string().min(1),
    apiKey: z.string().min(1),
    enrollment: z
      .object({
        claims: enrollmentClaimsSchema,
        signature_hex: z.string().regex(/^[0-9a-f]{64}$/),
        verification_secret_env: z.string().min(1),
      })
      .strict(),
    policyBundle: policyBundleSchema,
    bundlePublicKeyPem: z.string().min(1),
    expiresAt: z.string(),
  })
  .strict();

export type EnrollmentResponse = z.output<typeof enrollmentResponseSchema>;
