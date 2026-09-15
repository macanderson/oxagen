/**
 * `get_first_frame`: the register flow's "Wait for the first frame" step
 * (mockup `regRun`, `regSchedule`; #2967). For one registered agent: whether
 * a host has enrolled for it, what that host last reported, and the first
 * frame `ingest_tacho_events` accepted from it, which is the moment the agent
 * exists on Fleet.
 *
 * `waitMs` is the handler-side long poll, as on `get_run` (ARCHITECTURE.md
 * §3.5): the handler waits inside the tenant scope for up to that long for
 * the first frame, so the page's SSE stream costs one invoke per `waitMs`
 * rather than one per tick. Nothing here completes on a timer: with no frame
 * the answer is `firstFrame: null`, however long the wait.
 *
 * A console read: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { WAIT_MS_MAX } from "./run.get";

export const onboardingFirstFrameGet = registerCapability({
  name: "get_first_frame",
  domain: "onboarding",
  description:
    "For one registered agent: the host enrolled for it, what that host last reported, and the first frame ingested from it, long-polled for up to waitMs.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      /** Long-poll budget: wait up to this long for the first frame. */
      waitMs: z.number().int().min(0).max(WAIT_MS_MAX).default(0),
    })
    .strict(),
  output: z
    .object({
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      /** `org_ns.ws_ns.slug`; null when the agent's namespaces cannot be read. */
      agentKey: z.string().nullable(),
      /** The live host enrolled for this agent; null until `enroll_host` ran. */
      host: z
        .object({
          hostEnrollmentId: z.string().regex(/^tch_[0-9a-z]+$/),
          enrolledAt: z.string().datetime({ offset: true }),
          /** The collector's last heartbeat; null until it reports. */
          lastHeartbeatAt: z.string().datetime({ offset: true }).nullable(),
          /** The hooks as the collector last checked them; null until it reports. */
          hooksOk: z.boolean().nullable(),
        })
        .strict()
        .nullable(),
      /** The first session ingested from that host; null until it arrives. */
      firstFrame: z
        .object({
          /** The run the frame opened (`tse_…`), the row Fleet reads. */
          runId: z.string().regex(/^tse_[0-9a-z]+$/),
          /** When Oxagen stored the session, on the server's clock; the host's own timestamps are not used. */
          receivedAt: z.string().datetime({ offset: true }),
        })
        .strict()
        .nullable(),
    })
    .strict(),
});

export type OnboardingFirstFrameGetInput = z.output<
  typeof onboardingFirstFrameGet.input
>;
export type OnboardingFirstFrameGetOutput = z.output<
  typeof onboardingFirstFrameGet.output
>;
