// The onboarding gate and Register an agent view models (#2967, ADR-065): the
// gate row an organization carries (`get_onboarding_state`) and the wait for
// one registered agent's first frame (`get_first_frame`). A field is nullable
// exactly where the contract may not have recorded it (ARCHITECTURE.md §3.4).
// The seven-day conversion offer has no columns behind it (ADR-065 decision
// 3), so it has no view field.
import { z } from "zod";
import { PublicId } from "./common";

const Instant = z.iso.datetime({ offset: true });

/**
 * Where the organization stands. `organization` is the answer for a caller
 * with no organization; the row itself holds `wrap`, `run` or `unlocked`, and
 * only the first frame's ingest writes `unlocked`.
 */
export const OnboardingStep = z.enum([
  "organization",
  "wrap",
  "run",
  "unlocked",
]);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const OnboardingGate = z.object({
  step: OnboardingStep,
  /** The gate's workspace; null until the organization's first workspace exists (#4582). */
  workspace: z.object({ id: PublicId, slug: z.string().min(1) }).nullable(),
  /** Null until the first frame arrives, and for an organization that predates the gate. */
  firstFrameAt: Instant.nullable(),
  /** The run the first frame opened; null with `firstFrameAt`. */
  firstRunId: PublicId.nullable(),
});
export type OnboardingGate = z.infer<typeof OnboardingGate>;

export const FirstFrame = z.object({
  agentId: PublicId,
  /** `org_ns.ws_ns.slug`; null when the agent's namespaces cannot be read. */
  agentKey: z.string().min(1).nullable(),
  /** The live host enrolled for this agent; null until `enroll_host` ran. */
  host: z
    .object({
      hostEnrollmentId: PublicId,
      enrolledAt: Instant,
      /** The collector's last heartbeat; null until it reports. */
      lastHeartbeatAt: Instant.nullable(),
      /** The hooks as the collector last checked them; null until it reports. */
      hooksOk: z.boolean().nullable(),
    })
    .nullable(),
  /** The first session ingested from that host; null until it arrives. */
  firstFrame: z.object({ runId: PublicId, receivedAt: Instant }).nullable(),
});
export type FirstFrame = z.infer<typeof FirstFrame>;
