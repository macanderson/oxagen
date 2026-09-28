/**
 * `get_onboarding_state`: where the signed-in person is in the onboarding
 * gate (MC spec App. F: "the app does not open until an agent has talked to
 * Oxagen"; mockup `OB_STEPS`; #2967).
 *
 * Unscoped: the pre-org steps have no organization. A caller with no
 * organization is at `organization` (the next thing to do is name one); a
 * caller with one reads its `org.onboarding_state` row — `wrap`, `run`, or
 * `unlocked` — with the first frame the ingest recorded. Sign-up and email
 * verification are the session's, so the row starts at `wrap`. #4616 removed
 * the provisional window, which only a bound main repository closed.
 *
 * A console read is never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/** The gate's steps as the caller sees them; the row itself never holds `organization`. */
export const onboardingStepSchema = z.enum([
  "organization",
  "wrap",
  "run",
  "unlocked",
]);

export const onboardingStateGet = registerCapability({
  name: "get_onboarding_state",
  domain: "onboarding",
  description:
    "Where the signed-in person is in the onboarding gate: the current step, the gate's workspace, and the first frame once one arrived.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  noBillingGate: true,
  mutates: false,
  sensitivity: "low",
  // Every member may read the gate; a caller with no organization reads
  // `organization` and nothing else.
  defaultEffect: "allow",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: {},
  },
  input: z.object({}).strict(),
  output: z
    .object({
      step: onboardingStepSchema,
      /** The gate's workspace, the first one the organization made; null until that workspace exists (#4582). */
      workspace: z
        .object({
          id: z.string().regex(/^wrk_[0-9a-z]+$/),
          slug: z.string().min(1),
        })
        .strict()
        .nullable(),
      /** RFC 3339; null until the first frame arrives, and for an organization that predates the gate (it has no row). */
      firstFrameAt: z.string().datetime({ offset: true }).nullable(),
      /** The run the first frame opened (`tse_…`); null with `firstFrameAt`. */
      firstRunId: z.string().nullable(),
    })
    .strict(),
});

export type OnboardingStateGetInput = z.output<typeof onboardingStateGet.input>;
export type OnboardingStateGetOutput = z.output<
  typeof onboardingStateGet.output
>;
