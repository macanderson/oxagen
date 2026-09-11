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
  TACHO_BUNDLE_SCHEMA,
  TACHO_ENROLLMENT_CLAIMS_SCHEMA,
  controlEnvelopeSchema,
  deliveredCommandSchema,
  denyGenerationSchema,
  enrollmentClaimsSchema,
  hostEnrollmentIdSchema,
  policyBundleSchema,
  tachoBatchSchema,
  tachoBundleModeSchema,
  tachoCommandOutcomeSchema,
  tachoCommandSchema,
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
