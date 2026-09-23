/**
 * The wire documents that cross between a Tacho host and the control plane
 * (spec sections 5.2, 7.1, 7.4 and 3.1 step 3). They live in the leaf package
 * so the daemon, the hook binary, and the control plane validate the same
 * shapes; `packages/oxagen` re-exports these for its contracts.
 */
import { z } from "zod";
import { SHA256_DIGEST_PATTERN } from "./digest";
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

/**
 * The event attribute that marks a call as having come through the local MCP
 * gateway, and the value that says so.
 *
 * A wire constant rather than a literal at each end. The daemon writes this
 * attribute when it records a connected app's tool call; the control plane's
 * ingest reads it to file the call under the `gateway` enforcement tier. The
 * two live in different packages, and the only thing joining them is the
 * spelling of this key — so a rename on one side alone would not break a
 * build or a test. It would just stop matching, and every gateway call would
 * go on being filed as `observe` or `harness` with nothing to show for it.
 *
 * That silence is the same failure this attribute was added to fix
 * (discussion_r4034318913, where gateway attribution never reached the row).
 * Naming it once makes the rename a type error instead.
 */
export const TACHO_ENFORCEMENT_TIER_ATTR = "oxagen.enforcement_tier" as const;
export const TACHO_GATEWAY_TIER = "gateway" as const;

/**
 * The request header the local MCP gateway names its own chain on.
 *
 * A gateway call is forwarded to the control plane over the daemon's gateway
 * credential. The control plane knows from that credential which HOST it is
 * serving, and until #3221 nothing told it which of the host's chains — so
 * ingest read the correlation off the submitted batch instead, where anything
 * able to submit one could set it.
 *
 * This header is that correlation, sent by the party whose credential is being
 * authenticated. It is NOT identity: the org, the workspace and the host all
 * come from the key's own scope and this value is never allowed to influence
 * them. It answers one question the key cannot — which chain the caller was
 * serving — and the control plane files it beside its own record of the call.
 *
 * Lower-case because HTTP header names are case-insensitive and every reader
 * in this repo indexes a lower-cased map.
 */
export const TACHO_GATEWAY_SESSION_HEADER = "x-tacho-gateway-session" as const;

/**
 * The request header the local MCP gateway states its chain's GENESIS HASH on.
 *
 * The chain id alone is a name, and a name is something a forger can also
 * write. A holder of the host's ingest key who learns a real chain uuid can
 * open that session first with a chain of its own and then be promoted by the
 * next genuine gateway call, because every check the server could make —
 * the chain name, the session's lifetime — is satisfied by the forged row it
 * created.
 *
 * The genesis hash is the thing it cannot write. It is the hash of the
 * daemon's own first sealed event, so a chain that does not begin with that
 * exact event has a different one, and producing a different chain with the
 * same genesis hash is a preimage attack. The control plane records it beside
 * the chain name and ingest requires the session's recorded `genesis_hash` to
 * equal it.
 *
 * It is stable for the life of the chain, which is what makes this cheap: it
 * is sent on every gateway call and compared against a column the session row
 * already carries, with no lookup and nothing to keep in step.
 */
export const TACHO_GATEWAY_GENESIS_HEADER = "x-tacho-gateway-genesis" as const;

/**
 * How a model call's usage was learned, on the `llm_call` frame that carries
 * it (`attrs[TACHO_METERING_ATTR]`).
 *
 * `observed` is written by the loopback model proxy, which read the vendor's
 * own usage block off the response as it passed. Every other `llm_call` is the
 * harness's own telemetry, self-reported. The control plane counts the
 * observed frame and not the self-reported one when a session has both for
 * the same calls, so a session routed through the proxy is never counted
 * twice. A wire constant for the same reason the tier attribute is one: the
 * two ends live in different packages and only the spelling joins them.
 */
export const TACHO_METERING_ATTR = "oxagen.metering" as const;
export const TACHO_METERING_OBSERVED = "observed" as const;

/**
 * The request header a caller may name its session on when it talks to the
 * loopback model proxy. The value is the harness session id, the same one the
 * harness reports to its hooks. The proxy reads it and removes it; it is never
 * forwarded to the vendor.
 *
 * It is the explicit form of a correlation the proxy otherwise derives: from
 * `X-Claude-Code-Session-Id` and `metadata.user_id` for Claude Code, and from
 * the `session-id` header for Codex. A harness that sends none of those can
 * set this one (Claude Code reads extra headers from
 * `ANTHROPIC_CUSTOM_HEADERS`).
 */
export const TACHO_MODEL_SESSION_HEADER = "x-oxagen-session" as const;

/**
 * Which process held the credential a model call was made with (ADR-138),
 * as `attrs[TACHO_CREDENTIAL_BASIS_ATTR]` on every frame the loopback proxy
 * seals. `gateway_brokered`: the harness presented a run token and the
 * gateway attached the vendor credential from its custody. `harness_held`:
 * the harness's own credential crossed untouched, the way ADR-094 first
 * built it. A spend number reads the same either way; what differs is
 * whether the harness could have spent that credential anywhere else.
 */
export const TACHO_CREDENTIAL_BASIS_ATTR = "oxagen.credential_basis" as const;
export const TACHO_CREDENTIAL_GATEWAY_BROKERED = "gateway_brokered" as const;
export const TACHO_CREDENTIAL_HARNESS_HELD = "harness_held" as const;
export const TACHO_CREDENTIAL_BASES = [
  TACHO_CREDENTIAL_GATEWAY_BROKERED,
  TACHO_CREDENTIAL_HARNESS_HELD,
] as const;
export type TachoCredentialBasis = (typeof TACHO_CREDENTIAL_BASES)[number];
/** The id of the run token a brokered call presented; never the token. */
export const TACHO_RUN_TOKEN_ATTR = "oxagen.run_token_id" as const;

/**
 * A bundle field this host's parser understands, named on the wire so the
 * control plane can withhold fields the host would choke on.
 *
 * `policyBundleSchema` is `.strict()`, which makes every new bundle field a
 * migration rather than an extension: a daemon or CLI built before the field
 * rejects the **whole** mandate the day the control plane starts signing one
 * in, so a bundle refresh fails on every poll and the host is stranded on a
 * stale mandate, and a fresh enrollment cannot parse its first bundle at all.
 * The control plane is deployed before the fleet upgrades, so that is the
 * ordinary case, not the edge one.
 *
 * So a host declares what it can read, and the control plane emits a gated
 * field only to a host that named it. The declaration is a list of names
 * rather than a version because the question is per field — "can you read
 * *this*" — and a version answers it only for whoever remembers which release
 * each field landed in. Names a host does not recognise are simply absent
 * from its list; names the control plane does not recognise are ignored.
 *
 * This is a transition, not the resting state. Once the fleet is upgraded,
 * the field becomes required and the gate goes away — see the note on
 * `gateway_tools` below for why absent must not be read as a permissive
 * default in the meantime.
 */
export const BUNDLE_FEATURE_GATEWAY_TOOLS = "gateway_tools" as const;

/**
 * The host can parse `model_prices`, the price rows the loopback model proxy
 * prices an observed call with (story sheet item 10). Gated for the same
 * reason `gateway_tools` is: the bundle schema is strict, so a host built
 * before the field would reject the whole mandate.
 */
export const BUNDLE_FEATURE_MODEL_PRICES = "model_prices" as const;

/**
 * The host can parse `models`, the allow and deny lists the loopback model
 * proxy refuses a disallowed model against. Gated for the same reason
 * `gateway_tools` and `model_prices` are: the bundle schema is strict, so a
 * host built before the field would reject the whole mandate rather than the
 * one field it does not know.
 *
 * Nothing emits this field yet. `unsignedBundle` leaves it out of every
 * bundle it signs, so a host that advertises the feature is told no list and
 * refuses no model. The workspace's saved lists are stored and read back and
 * govern no machine until the control plane emits them; the panel that sets
 * them says so. See `docs/audits/2026-09-21-model-gateway-arming.md`.
 */
export const BUNDLE_FEATURE_MODEL_ALLOWLIST = "models" as const;

/**
 * The host can parse `hook_fail_open`: the list of hook paths the local
 * evaluator answers allow on when a decision cannot be made against the
 * cached bundle (the daemon unreachable, or the event carrying no tool
 * identity to evaluate). Gated for the same reason `gateway_tools` is: the
 * bundle schema is strict, so a host built before the field would reject the
 * whole mandate.
 *
 * The list itself is a static property of `packages/tacho`'s own hook-client
 * code (`FAIL_OPEN_HOOK_PATHS` in `claude-code/hook-client.ts`), not of any
 * one mandate, and is signed into every bundle a host that advertises this
 * feature receives, so the fail-open set an operator relies on is read from
 * the record rather than from source.
 */
export const BUNDLE_FEATURE_HOOK_FAIL_OPEN = "hook_fail_open" as const;

/**
 * The host can parse `context.manifest`: the assembler's account of every
 * steering candidate the bundle's `context.system` was assembled from, and
 * why each was included or cut (ADR-093, ADR-143). Gated for the same reason
 * `gateway_tools` is: `context` is strict, so a host built before the field
 * would reject the whole mandate. A host that advertises it seals the
 * manifest into each session's chain as a `steering.manifest` frame at
 * `SessionStart`, beside the `oxagen.context_digest` attribute it already
 * writes, so the run record says which records the agent saw.
 */
export const BUNDLE_FEATURE_STEERING_MANIFEST = "steering_manifest" as const;

/**
 * Every bundle feature the host in *this* tree can parse, which is what it
 * advertises. One list, read by the daemon's health report and by enrollment,
 * so a field added to `policyBundleSchema` is advertised from the one place
 * that also declares it.
 */
export const TACHO_BUNDLE_FEATURES = [
  BUNDLE_FEATURE_GATEWAY_TOOLS,
  BUNDLE_FEATURE_MODEL_PRICES,
  BUNDLE_FEATURE_MODEL_ALLOWLIST,
  BUNDLE_FEATURE_HOOK_FAIL_OPEN,
  BUNDLE_FEATURE_STEERING_MANIFEST,
] as const;

export type TachoBundleFeature = (typeof TACHO_BUNDLE_FEATURES)[number];

/**
 * A host's advertised feature list, as the control plane accepts it. Plain
 * strings rather than the enum: a host from a later release may name a field
 * this control plane has never heard of, and refusing its whole poll over a
 * word it does not know would be the same mistake in the other direction.
 */
export const bundleFeaturesSchema = z.array(z.string().max(64)).max(32);

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
 * `claude-code/stella-adapter.ts` in both directions. Cursor's differs on
 * all three of the things that would have let it share Claude Code's path
 * (`conversation_id` not `session_id`, `preToolUse` not `PreToolUse`, a flat
 * permission object not `hookSpecificOutput`), so `--harness cursor` routes
 * through `claude-code/cursor-adapter.ts` for the same reason.
 */
export const tachoHarnessSchema = z.enum([
  "claude-code",
  "codex",
  "cursor",
  "stella",
  "claude-desktop",
]);
export type TachoHarness = z.infer<typeof tachoHarnessSchema>;

/** How each harness is named to a person: detect, status, the agent roster. */
export const TACHO_HARNESS_LABELS: Record<TachoHarness, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
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
    cursor: "harness",
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
export const WRAPPED_HARNESSES = [
  "claude-code",
  "codex",
  "cursor",
  "stella",
] as const;
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

/**
 * The same command as a RESPONSE carries it, tolerant of keys this build has
 * never heard of.
 *
 * The schema above stays strict, and the control plane keeps checking what it
 * is about to send against it: a key it did not mean to send is drift, and
 * that is the side where drift must be caught. This copy is the one a host
 * parses. The envelope's own tolerance stopped at the array, so the failure it
 * closes stayed open one level down: a single optional field added to a
 * delivered command failed the array, the whole poll and ingest response
 * failed with it, the host stopped acknowledging batches, and `pause`,
 * `cancel` and `kill` stopped arriving on a host that reported itself healthy.
 */
export const deliveredCommandResponseSchema =
  deliveredCommandSchema.passthrough();

export type DeliveredCommandResponse = z.output<
  typeof deliveredCommandResponseSchema
>;

/** The forces a steering item carries, in the order the assembler ranks them. */
export const steeringForceSchema = z.enum(["must", "should", "may", "info"]);

/** The source families a steering item comes from (ADR-093 §2, plus `steer`). */
export const steeringItemKindSchema = z.enum([
  "record",
  "steer",
  "skill",
  "memory",
  "ontology",
  "policy",
  "instruction",
]);

/** Why the assembler cut an item. */
export const steeringCutReasonSchema = z.enum(["tier", "budget", "superseded"]);

export const steeringManifestItemSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: steeringItemKindSchema,
    force: steeringForceSchema,
    recorded_at: z.string().max(64),
    tokens: z.number().int().nonnegative(),
    outcome: z.enum(["included", "cut"]),
    reason: steeringCutReasonSchema.optional(),
    superseded_by: z.string().min(1).max(256).optional(),
  })
  .strict();

export const STEERING_MANIFEST_SCHEMA = "oxagen.steering.manifest/1" as const;

/**
 * The assembler's manifest (ADR-093): every candidate for the bundle's
 * `context.system`, in rank order, with what happened to it. This is the
 * leaf's own copy of the shape `@oxagen/steering-assembler` produces, the
 * way the usage-telemetry schema is carried (H7): the control plane checks
 * what it signs against this, and `packages/handlers` holds the test that
 * keeps the two in step.
 */
export const steeringManifestSchema = z
  .object({
    schema: z.literal(STEERING_MANIFEST_SCHEMA),
    delivers: z.array(steeringForceSchema).max(4),
    budget_tokens: z.number().int().nonnegative(),
    spent_tokens: z.number().int().nonnegative(),
    included: z.number().int().nonnegative(),
    cut: z.number().int().nonnegative(),
    text_digest: z.string().regex(SHA256_DIGEST_PATTERN).nullable(),
    items: z.array(steeringManifestItemSchema).max(2_000),
  })
  .strict();

export type SteeringManifest = z.output<typeof steeringManifestSchema>;
export type SteeringManifestItem = z.output<typeof steeringManifestItemSchema>;

/**
 * The body of a `steering.manifest` frame: the bundle's manifest, the bundle
 * it came from, and the steers the host delivered beside the prefix at that
 * boundary, each appended as an included `steer` item. The host ranks
 * nothing; it reports what it delivered.
 */
export const steeringManifestFrameSchema = steeringManifestSchema
  .extend({
    bundle_version: z.number().int().nonnegative(),
    bundle_etag: z.string().min(1),
  })
  .strict();

export type SteeringManifestFrame = z.output<
  typeof steeringManifestFrameSchema
>;

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
        /**
         * Declared, and read by nothing on the host. The control plane stopped
         * signing it (#3728) because the model proxy refuses against the
         * session limit only. It stays in this `.strict()` schema so a host
         * still parses a bundle from a control plane that signs it.
         */
        daily_limit_usd: z.number().nonnegative().optional(),
        mode: z.enum(["observed", "enforced"]),
      })
      .strict(),
    context: z
      .object({
        system: z.string().max(16_384).nullable(),
        /**
         * Emitted only to a host that advertised
         * `BUNDLE_FEATURE_STEERING_MANIFEST`; see that constant.
         */
        manifest: steeringManifestSchema.optional(),
      })
      .strict(),
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
    /**
     * Every tool the gateway mandate permits a connected app to call
     * (ADR-078 §4). The local MCP gateway filters a `tools/list` down to this
     * set before it counts it against `tool_ceiling` and serves it.
     *
     * It is a list here and a rule on the control plane, and it has to be
     * both. The rule — an `mcp` capability that does not mutate and is not
     * high-sensitivity — is evaluated by `gatewayMayInvoke` in `@oxagen/iam`,
     * against the capability registry, and enforced in the kernel's IAM
     * adapter at `invoke()` time. `@oxagen/tacho` is a leaf package with no
     * `@oxagen/*` runtime dependency, so the host cannot evaluate that rule
     * and must not try; it is handed the rule's answer, signed, with the rest
     * of the mandate.
     *
     * Without it the gateway advertised the whole toolbelt and refused the
     * forbidden part only when a tool was selected, so a connected app was
     * shown tools that could only fail, and a `tool_ceiling` was counted
     * against a list including tools the mandate forbids — refusing a toolbelt
     * that would have fit.
     *
     * Optional, and absent means *no allowance this host has been told about*
     * rather than *an empty allowance* — the same reading `tool_ceiling`
     * carries. A bundle from a control plane older than this field declares
     * none, and the gateway then serves what it is given rather than filtering
     * everything away. An allowance that is present and empty is a mandate
     * that permits nothing, and the gateway serves nothing.
     *
     * **The optionality is a rollout constraint, not a permissive default.**
     * An unfiltered `tools/list` is the hole this field closes, so absent is
     * the weak answer and we would rather not have it. It stays optional only
     * because this schema is `.strict()` and every host deployed before the
     * field rejects a bundle carrying it — so phase 1 emits it only to a host
     * that advertised `BUNDLE_FEATURE_GATEWAY_TOOLS`, and a host that did not
     * keeps the behaviour it already had. Phase 2, once the fleet is
     * upgraded, makes this required and deletes the gate, at which point
     * absent stops being representable. Do not read the `.optional()` as a
     * decision that unfiltered is acceptable, and do not delete the gate as
     * dead weight before the fleet is there.
     */
    gateway_tools: z.array(z.string().max(256)).max(4096).optional(),
    /**
     * The hook paths this host's local evaluator answers allow on when it
     * cannot reach the daemon and cannot decide from the cached bundle
     * (§ BUNDLE_FEATURE_HOOK_FAIL_OPEN above). A fixed property of this
     * tacho release, copied verbatim from `FAIL_OPEN_HOOK_PATHS`
     * (`claude-code/hook-client.ts`) rather than computed per host, so the
     * set an operator reads off a signed bundle is the set the code actually
     * takes, not a description that can drift from the evaluator it
     * documents without also failing `hook-client.test.ts`.
     *
     * Optional, and absent means *this host was not told*, the same reading
     * `gateway_tools` carries: emitted only once a host advertises
     * `BUNDLE_FEATURE_HOOK_FAIL_OPEN`, because the schema is `.strict()`.
     */
    hook_fail_open: z.array(z.string().max(64)).max(16).optional(),
    /**
     * The price rows the loopback model proxy prices an observed call with, so
     * `budget.session_limit_usd` can be enforced on the machine without the
     * host holding a price of its own (the leaf package cannot read the price
     * book). Each figure is integer micro-USD per one million tokens, the
     * price book's own unit. `model` is matched by longest prefix within the
     * provider, the way the price book resolves a dated model id.
     *
     * Optional, and absent means *no prices this host has been told about*: a
     * call it cannot price costs the session budget nothing and is recorded as
     * `observed_unpriced`. Emitted only to a host that advertised
     * `BUNDLE_FEATURE_MODEL_PRICES`.
     */
    model_prices: z
      .array(
        z
          .object({
            provider: z.enum(["anthropic", "openai"]),
            model: z.string().min(1).max(256),
            input: z.number().int().nonnegative(),
            output: z.number().int().nonnegative(),
            cache_read: z.number().int().nonnegative(),
            cache_write: z.number().int().nonnegative(),
            cache_write_1h: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(1024)
      .optional(),
    /**
     * Which models this workspace permits a wrapped harness to call, and which
     * it refuses outright. Read by `refusalFor` in the loopback model proxy,
     * which answers `model_not_permitted` before the request is forwarded.
     *
     * `allow: null` and `allow: []` are different decisions and do not share
     * an encoding, the same reading `gateway_tools` carries. `null` is *no
     * allowlist stated*, so every model passes and only `deny` narrows.
     * `[]` is an allowlist that permits nothing, and the proxy refuses every
     * model — a workspace that has turned the gateway off at the model layer,
     * which is a decision somebody can make.
     *
     * The whole object is optional, and absent means *no model policy this
     * host has been told about*, never *no policy*. Emitted only to a host
     * that advertised `BUNDLE_FEATURE_MODEL_ALLOWLIST`, because this schema is
     * `.strict()` and a daemon built before the field would reject the entire
     * mandate over it. Read the optionality as the rollout constraint it is;
     * a host that has not advertised calls whatever it likes until it
     * upgrades, and `update_tacho_session_policy` reports how many hosts are
     * in that state so nobody mistakes a saved list for an applied one.
     *
     * Both lists apply only when `budget.mode` is `enforced`. One word
     * answers "does this host refuse anything", rather than two clauses that
     * can disagree.
     */
    models: z
      .object({
        allow: z.array(z.string().min(1).max(256)).max(256).nullable(),
        deny: z.array(z.string().min(1).max(256)).max(256),
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
    /**
     * The bundle fields this daemon can parse (`TACHO_BUNDLE_FEATURES`).
     *
     * It rides the health report because that is the only channel the host
     * sends on *every* control poll, and the answer has to be a per-host fact
     * the control plane has stored rather than a per-request one. The control
     * envelope on an ingest or a command poll publishes `bundle_etag`, and
     * the daemon refetches whenever it differs from the bundle it holds; if
     * the gate answered from the request, the etag would differ between the
     * two paths and the host would refetch forever.
     *
     * Optional, and absent means a host that predates the advertisement —
     * which is exactly a host that cannot parse a gated field, so absent and
     * empty lead to the same emission.
     */
    bundle_features: bundleFeaturesSchema.optional(),
    /**
     * Whether each routed harness still points at the loopback proxy.
     *
     * Enrollment writes the proxy's URL into `~/.claude/settings.json` and
     * `~/.codex/config.toml`, and one file edit takes it back out, with no
     * restart and nothing to stop it. Before this field the control plane saw
     * only the effect — sessions stopped reaching the `gateway` tier — and a
     * laptop that is merely closed looks the same. The 2026-09-21 gateway
     * audit called that the pattern across every bypass row: the proxy's own
     * presence is well defended, and whether the harness was pointed at it is
     * enforced by nothing and reported by nothing.
     *
     * The value the file holds is not sent. `ours` answers the question, and
     * a URL a person chose for their own machine is theirs. `shadowed_by`
     * names the managed settings file that overrides ours when one does,
     * because that is an administrator's doing and not the user's.
     *
     * Optional, and absent means *this daemon said nothing*, which is a
     * daemon that predates the field — never *nothing has drifted*.
     */
    model_base_urls: z
      .array(
        z
          .object({
            harness: z.string().max(64),
            /** The config key, as a person would name it. */
            key: z.string().max(128),
            ours: z.boolean(),
            shadowed_by: z.string().max(512).optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    /**
     * Which model providers this host brokers credentials for (ADR-138): the
     * gateway holds the vendor key and the harness holds a run token. A
     * provider absent from the list is `harness_held`. Names and a basis,
     * never a secret or a digest of one. Optional: a daemon that predates
     * custody reports nothing here, and the control plane reads absent as
     * `harness_held` for every provider.
     */
    credentials: z
      .array(
        z
          .object({
            provider: z.enum(["anthropic", "openai"]),
            basis: z.enum(TACHO_CREDENTIAL_BASES),
          })
          .strict(),
      )
      .max(8)
      .optional(),
  })
  .strict();

export type DaemonHealth = z.output<typeof daemonHealthSchema>;

/** One harness's base-URL state, as the health report carries it. */
export type ModelBaseUrlReport = NonNullable<
  DaemonHealth["model_base_urls"]
>[number];

export const TACHO_MAX_BATCH = 200;

/**
 * Base64 on the wire costs four bytes for every three, rounded up to the
 * next quad. Every cap below is compared against the request budget through
 * this, because the budget is spent in encoded bytes and the caps are
 * written in raw ones.
 */
export const base64Size = (bytes: number): number => Math.ceil(bytes / 3) * 4;

/**
 * The most bytes one frame body may carry, before base64.
 *
 * This cap and `TACHO_MAX_REQUEST_BYTES` have to agree, and they did not. An
 * earlier pass sized these against a route that hardcoded a 1 MiB request
 * limit, which was true when it was written. The route now imports the host's
 * own ceiling, so
 * the hand-written caps silently became a downgrade: every `content_exact`
 * body over the smaller number was marked too large and its bytes were
 * never written, which is the content a workspace pays to keep.
 *
 * A cap above the budget produces a request nobody can ship, and a cap far
 * below it discards recordings for nothing. Deriving both from the budget
 * is the only way neither happens again when one of them moves.
 */
export const TACHO_MAX_BODY_BYTES = 1_048_576;

/**
 * The most bytes one ingest request may carry, as JSON on the wire. The
 * control plane's route refuses anything larger with 413, and the API runs
 * on Vercel, whose functions refuse a request body over 4.5 MB before the
 * route sees it, so this sits under both.
 *
 * The shipper measures events and base64-encoded bodies against this number,
 * not raw body bytes. Base64 inflates a body by a third, so one
 * `TACHO_MAX_BODY_BYTES` body is about 1.4 MB on the wire and always fits
 * with its event.
 */
export const TACHO_MAX_REQUEST_BYTES = 4 * 1_048_576;

/**
 * Room the shipper keeps under `TACHO_MAX_REQUEST_BYTES` for what it does not
 * measure per event: the batch envelope, `daemon` health, and JSON
 * punctuation.
 */
export const TACHO_REQUEST_ENVELOPE_BYTES = 64 * 1024;

/**
 * A frame body shipped next to its event (Mission Control spec §8.2; tacho
 * spec §2 "Bodies are digested, content is governed"). The host redacts and
 * digests the bytes before it chains `content.digest`; the control plane
 * verifies the digest, refuses bytes its own detectors would redact, and
 * writes the object whose reference the row records. A body naming an event
 * outside the batch, or one whose digest disagrees, is refused and the event
 * is recorded without a body.
 */
export const tachoBodySchema = z
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

/**
 * What every machine-to-machine response carries back (spec section 7.4).
 *
 * TOLERANT OF UNKNOWN KEYS, unlike everything this file sends. A host is
 * installed on someone's laptop and updates when they get round to it; the
 * control plane deploys continuously. So the server WILL at some point answer
 * a host older than itself, and under `.strict()` every additive field it adds
 * turns into a fleet-wide ingest outage — the response fails to parse, the
 * batch is never acknowledged, and the host spools for ever while reporting
 * itself healthy. That is not hypothetical: it has now happened three times
 * (`user_email`, the bundle's new field, and `body_rejections`, which had
 * 3,526 events stranded on one host with "last ingest never").
 *
 * Strictness still guards the two directions that need it — what this host
 * SENDS, and what it accepts from producers (see envelope.ts, where drift in
 * an agent's output must be refused rather than silently absorbed). What the
 * control plane says back to us is not that kind of input: it is a newer
 * version of ourselves, and the compatible move is to ignore what we do not
 * yet understand.
 */
export const controlEnvelopeSchema = z
  .object({
    host_status: tachoHostStatusSchema,
    deny_generation: denyGenerationSchema,
    bundle_etag: z.string().min(1),
    // Tolerant per element as well as per envelope: a strict array inside a
    // tolerant wrapper is the same outage one level down.
    commands: z.array(deliveredCommandResponseSchema).max(100),
  })
  .passthrough();

export type ControlEnvelope = z.output<typeof controlEnvelopeSchema>;

/** The ingest response as the host reads it. Tolerant for the reason on `controlEnvelopeSchema`. */
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
        .passthrough(),
    ),
    /**
     * Bodies the control plane refused: the event was recorded without one and
     * the session carries a `body_missing` gap. Optional here although the
     * server's contract always sends it, so that a host also parses the
     * response of a control plane older than itself.
     */
    body_rejections: z
      .array(
        z
          .object({
            event_id_idem: z.string(),
            reason: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    control: controlEnvelopeSchema,
  })
  .passthrough();

export type IngestResponse = z.output<typeof ingestResponseSchema>;

/** Tolerant for the reason on `controlEnvelopeSchema` — this is a response. */
export const bundleResponseSchema = z
  .object({
    not_modified: z.boolean(),
    etag: z.string().min(1),
    bundle: policyBundleSchema.nullable(),
  })
  .passthrough();

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

/**
 * Tolerant, for the reason on `controlEnvelopeSchema`: this is a response,
 * and a host is updated when its owner gets round to it. Making only the
 * nested `control` envelope tolerant changed nothing while this wrapper stayed
 * strict — `createControlClient.commands()` parses the wrapper FIRST, so one
 * additive top-level field from a newer control plane still stopped the host
 * polling and delivering acknowledgements, the exact skew this exists to
 * survive.
 */
export const commandsResponseSchema = z
  .object({
    acknowledged: z.number().int().nonnegative(),
    control: controlEnvelopeSchema,
  })
  .passthrough();

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
  // The outer wrapper is unsigned and tolerant, like every other response
  // here, so a control plane that adds a field does not break enrollment on
  // hosts older than it. The signed `enrollment` document inside stays
  // `.strict()`: its claims are verified against a signature, and an
  // unexpected key there is a defect in what was signed, not version skew.
  .passthrough();

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
  .passthrough();

export type TokenEnrollmentResponse = z.output<
  typeof tokenEnrollmentResponseSchema
>;
