/**
 * The wire documents that cross between a Tacho host and the control plane
 * (spec sections 5.2, 7.1, 7.4 and 3.1 step 3). They live in the leaf package
 * so the daemon, the hook binary, and the control plane validate the same
 * shapes; `packages/oxagen` re-exports these for its contracts.
 */
import { z } from "zod";
import { TACHO_RUNTIMES, tachoEventSchema, type TachoEvent } from "./envelope";

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
 * runs through the same `tacho-hook` with a `--harness codex` tag. Stella's
 * does not: its payload names no session and its answers are
 * `{"action": ...}` decisions, so `--harness stella` routes the hook through
 * `claude-code/stella-adapter.ts` in both directions.
 */
export const tachoHarnessSchema = z.enum([
  "claude-code",
  "codex",
  "stella",
  "claude-desktop",
]);
export type TachoHarness = z.infer<typeof tachoHarnessSchema>;

/** How each harness is named to a person: detect, status, the agent roster. */
export const TACHO_HARNESS_LABELS: Record<TachoHarness, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  stella: "Stella",
  "claude-desktop": "Claude Desktop",
};

/**
 * Which enforcement tier a harness can reach on this machine (ADR-078), using
 * the `enforcement_tier` vocabulary the record already speaks.
 *
 * `harness` — **wrapped.** A `PreToolUse` hook sees every action the agent
 * takes, including the harness's own Bash and Edit, and can answer deny. It
 * runs inside a process Oxagen does not own, so the record is
 * `client_attested`: an action the agent did not report is one Oxagen never
 * saw, not one it can flag as skipped.
 *
 * `gateway` — **connected.** No hook surface exists, so Oxagen sees only the
 * calls routed through its MCP gateway. For those, the kernel evaluates and
 * refuses on the server, so a deny is a refusal rather than an attestation.
 *
 * Neither dominates the other. Wrapped is broader and weaker; connected is
 * narrower and stronger. Nothing that renders a harness may put them on one
 * axis — see ADR-078 §2.
 */
export const TACHO_HARNESS_TIERS: Record<TachoHarness, "harness" | "gateway"> =
  {
    "claude-code": "harness",
    codex: "harness",
    stella: "harness",
    "claude-desktop": "gateway",
  };

/**
 * The harnesses Tacho wraps with a hook, and the ones it connects through the
 * local MCP gateway. Written out rather than derived from `TACHO_HARNESS_TIERS`
 * so each carries a literal type, which is what makes a per-tier lookup table
 * (a harness binary to probe, a runtime to file a session under) total for the
 * tier it belongs to and absent for the other. `wire.test.ts` asserts the two
 * lists partition the enum and agree with the tier map, so a harness added
 * without being classified fails the build rather than defaulting to wrapped.
 */
export const WRAPPED_HARNESSES = ["claude-code", "codex", "stella"] as const;
export type WrappedHarness = (typeof WRAPPED_HARNESSES)[number];

export const CONNECTED_HARNESSES = ["claude-desktop"] as const;
export type ConnectedHarness = (typeof CONNECTED_HARNESSES)[number];

export function isWrappedHarness(harness: string): harness is WrappedHarness {
  return (WRAPPED_HARNESSES as readonly string[]).includes(harness);
}

export function isConnectedHarness(
  harness: string,
): harness is ConnectedHarness {
  return (CONNECTED_HARNESSES as readonly string[]).includes(harness);
}

/** What each tier does and does not record, in one line, for any surface. */
export const TACHO_TIER_SUMMARY: Record<"harness" | "gateway", string> = {
  harness:
    "Records every action, including this agent's own commands and file edits. Oxagen does not run the process, so the record is what the agent reported.",
  gateway:
    "Records only the Oxagen tools this app calls, and refuses the ones its mandate does not allow. It does not record prompts, model calls, or anything else the app does.",
};

/**
 * A custom agent's name (`tacho hook --agent <name>`). It becomes the
 * session's `agent.harness` and the roster label, so it is held to a
 * slug: lowercase, no spaces, short enough for every column that shows it.
 */
export const CUSTOM_AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Names a custom agent may not take: every built-in harness and runtime.
 * A custom agent named `stella` would carry `harness: "stella"`, and the
 * fleet page and the desktop app, which label rows by harness, would show
 * it as the built-in Stella. Derived from both lists, so a new harness or
 * runtime is reserved the day it is added.
 */
export const RESERVED_AGENT_NAMES: readonly string[] = [
  ...new Set<string>([...tachoHarnessSchema.options, ...TACHO_RUNTIMES]),
];

/** Why a custom agent name is refused, or undefined when it is acceptable. */
export function customAgentNameProblem(name: string): string | undefined {
  if (!CUSTOM_AGENT_NAME_PATTERN.test(name))
    return `expected ${CUSTOM_AGENT_NAME_PATTERN.source}`;
  if (RESERVED_AGENT_NAMES.includes(name))
    return `${JSON.stringify(name)} is a built-in harness or runtime name (reserved: ${RESERVED_AGENT_NAMES.join(", ")})`;
  return undefined;
}

export const customAgentNameSchema = z.string().superRefine((name, ctx) => {
  const problem = customAgentNameProblem(name);
  if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
});
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
/**
 * The statuses a connection point is in a position to assert about itself.
 * `expired` is among them: the host holds the deadline for a command it
 * received, and reports the expiry that passed with no boundary reached.
 * `sent` is Oxagen's own act and stays Oxagen's to record.
 */
export const tachoCommandAckStatusSchema = tachoCommandStatusSchema.extract([
  "received",
  "acknowledged",
  "applied",
  "expired",
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
    /**
     * The ceiling the mandate puts on how many tools may be advertised to a
     * connected app, and the model whose limit it is (ADR-078). Read by the
     * local MCP gateway, which refuses a `tools/list` that overflows it rather
     * than letting the provider refuse the turn with an error about a number
     * nobody can inspect.
     *
     * Optional, and absent means *no ceiling this host has been told about* —
     * not *no ceiling*, the same reading `PROVIDER_TOOL_LIMITS` documents for
     * a provider missing from its table. It has to be declared here because
     * this schema is `.strict()`: a bundle carrying a field the schema does
     * not name fails to parse, so a host that did not know the field would
     * reject the whole mandate the day the control plane started signing one.
     */
    tool_ceiling: z
      .object({
        model_id: z.string().min(1).max(256),
        max_tools: z.number().int().positive(),
        /** Where the number comes from; quoted verbatim into the refusal. */
        source: z.string().min(1).max(512),
      })
      .strict()
      .optional(),
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
    /**
     * The workspace MCP endpoint the local gateway proxies to (ADR-078).
     * Optional so a claim signed before the gateway existed still verifies;
     * when present it is authoritative and `mcpEndpointFor` stops deriving
     * one from `api_url`, which is guesswork a signed claim should replace.
     */
    mcp_endpoint: z.string().url().optional(),
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

/** The most bytes one frame body may carry, before base64. */
const TACHO_MAX_BODY_BYTES = 1_048_576;

/**
 * A frame body shipped next to its event (Mission Control spec §8.2; tacho
 * spec §2 "Bodies are digested, content is governed"). The host redacts and
 * digests the bytes before it chains `content.digest`; the control plane
 * verifies the digest, refuses bytes its own detectors would redact, and
 * writes the object whose reference the row records. A body naming an event
 * outside the batch, or one whose digest disagrees, is refused and the event
 * is recorded without a body.
 */
const tachoBodySchema = z
  .object({
    event_id_idem: z.string().regex(/^evt_[0-9a-f]{64}$/),
    content_type: z.string().min(1).max(128),
    bytes_base64: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .max(Math.ceil(TACHO_MAX_BODY_BYTES / 3) * 4),
  })
  .strict();

export type TachoBody = z.output<typeof tachoBodySchema>;

/** The wire batch a host ships (spec section 3.1 step 3). */
export const tachoBatchSchema = z
  .object({
    schema: z.literal(TACHO_BATCH_SCHEMA),
    host_enrollment_id: hostEnrollmentIdSchema,
    events: z.array(tachoEventWireSchema).min(1).max(TACHO_MAX_BATCH),
    /** Bodies for events in this batch, at most one per event. */
    bodies: z.array(tachoBodySchema).max(TACHO_MAX_BATCH).optional(),
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
    /**
     * The credential the local MCP gateway serves a connected app with
     * (ADR-078). Optional: a control plane older than the gateway mints only
     * the host key, and a host that gets none serves no tools rather than
     * falling back to the host key -- which is the escalation this exists to
     * prevent.
     */
    gatewayApiKeyPublicId: z.string().min(1).optional(),
    gatewayApiKey: z.string().min(1).optional(),
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

/**
 * What `enroll_host` answers a machine that presented a one-time enrollment
 * token: the enrollment document plus the tenant the token named, which the
 * host did not know before the call.
 */
export const tokenEnrollmentResponseSchema = enrollmentResponseSchema
  .extend({
    agentId: z.string().min(1),
    orgSlug: z.string().min(1),
    workspaceSlug: z.string().min(1),
  })
  .strict();

export type TokenEnrollmentResponse = z.output<
  typeof tokenEnrollmentResponseSchema
>;
