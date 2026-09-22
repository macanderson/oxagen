/**
 * Zod shapes shared by the Tacho contracts (docs/specs/tacho/spec.md
 * sections 5 to 7). The wire documents themselves are defined once in the
 * leaf package so the daemon, the hook binary, and the control plane
 * validate identical shapes; this module re-exports them and adds the
 * operator-facing summaries only the control plane returns.
 */
import { z } from "zod";

export {
  TACHO_BATCH_SCHEMA,
  TACHO_GATEWAY_GENESIS_HEADER,
  TACHO_GATEWAY_SESSION_HEADER,
  TACHO_BUNDLE_SCHEMA,
  TACHO_COMMANDS_SCHEMA,
  TACHO_ENROLLMENT_CLAIMS_SCHEMA,
  controlEnvelopeSchema,
  deliveredCommandSchema,
  denyGenerationSchema,
  enrollmentClaimsSchema,
  hostEnrollmentIdSchema,
  policyBundleSchema,
  tachoBatchSchema,
  tachoBundleModeSchema,
  tachoCommandAckStatusSchema,
  tachoCommandSchema,
  tachoCommandStatusSchema,
  tachoDeliveryModeSchema,
  tachoEventWireSchema,
  tachoHarnessSchema,
  tachoHostStatusSchema,
  tachoPlatformSchema,
} from "@oxagen/tacho";
export type { EnrollmentClaims, PolicyBundle, TachoBatch } from "@oxagen/tacho";
import {
  hostEnrollmentIdSchema,
  tachoBundleModeSchema,
  tachoHostStatusSchema,
  tachoPlatformSchema,
} from "@oxagen/tacho";

export const tachoSessionOutcomeSchema = z.enum([
  "running",
  "completed",
  "aborted",
  "crashed",
  "unknown",
]);

export const hostSummarySchema = z
  .object({
    hostEnrollmentId: hostEnrollmentIdSchema,
    agentKey: z.string(),
    hostname: z.string(),
    platform: tachoPlatformSchema,
    osUser: z.string(),
    status: tachoHostStatusSchema,
    mode: tachoBundleModeSchema,
    harnesses: z.array(z.string()),
    /**
     * The enforcement tier each of this host's harnesses reaches (ADR-078),
     * using the `enforcement_tier` vocabulary the session record already
     * speaks. `harness` is a *wrapped* app: a PreToolUse hook sees every
     * action it takes, but runs in a process Oxagen does not own, so the
     * record is what the agent reported. `gateway` is a *connected* app: no
     * hook exists, so Oxagen sees only the calls routed through its MCP
     * gateway — and refuses those on the server.
     *
     * Neither tier dominates the other, and a surface that renders them on
     * one axis is wrong in both directions. Carried per harness rather than
     * per host because one machine normally has both.
     */
    tiers: z.record(z.string(), z.enum(["gateway", "harness"])),
    /**
     * Whether each routed harness on this machine still points its model calls
     * at the loopback proxy, as the daemon last reported.
     *
     * A tier that stops saying `gateway` is a symptom with several causes — a
     * closed laptop looks the same as a reverted base URL — so the cause is
     * carried separately. `ours: false` is a harness whose config file no
     * longer names the proxy; `shadowedBy` names the managed settings file
     * that overrides ours when an administrator has set one.
     *
     * Empty means *this daemon reported nothing*, which is a daemon older than
     * the field, never *nothing has drifted*.
     */
    modelBaseUrls: z.array(
      z
        .object({
          harness: z.string(),
          /** The config key, as a person would name it. */
          key: z.string(),
          ours: z.boolean(),
          shadowedBy: z.string().nullable(),
        })
        .strict(),
    ),
    claudeVersionAtEnroll: z.string().nullable(),
    wrapperVersion: z.string().nullable(),
    managed: z.boolean(),
    lastSeenAt: z.string().nullable(),
    lastIngestAt: z.string().nullable(),
    hooksOk: z.boolean().nullable(),
    otelOk: z.boolean().nullable(),
    spoolDepth: z.number().int(),
    sessionsCount: z.number().int(),
    unobservedSessionsCount: z.number().int(),
    incidentsOpen: z.number().int(),
    expiresAt: z.string(),
    revokedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();

export const sessionSummarySchema = z
  .object({
    sessionUuid: z.string().uuid(),
    harnessSessionId: z.string(),
    hostEnrollmentId: hostEnrollmentIdSchema.nullable(),
    agentKey: z.string(),
    parentSessionUuid: z.string().uuid().nullable(),
    subagentType: z.string().nullable(),
    runtime: z.string(),
    harness: z.string(),
    harnessVersion: z.string().nullable(),
    outcome: tachoSessionOutcomeSchema,
    enforcementTier: z.enum(["gateway", "harness", "observe"]),
    startedAt: z.string(),
    lastEventAt: z.string(),
    endedAt: z.string().nullable(),
    cwd: z.string().nullable(),
    gitBranch: z.string().nullable(),
    modelInitial: z.string().nullable(),
    numTurns: z.number().int(),
    numToolCalls: z.number().int(),
    numModelCalls: z.number().int(),
    totalCostMicros: z.number().int(),
    seqCount: z.number().int(),
    chainVerified: z.boolean(),
    unobservedTail: z.boolean(),
    title: z.string().nullable(),
  })
  .strict();
