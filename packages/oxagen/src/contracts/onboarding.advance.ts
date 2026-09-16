/**
 * `advance_onboarding`: the gate's operator-driven step transitions (#2967).
 *
 * The operator moves between `wrap` ("I have already installed it —
 * continue") and `run` (Back). `unlocked` is not a target: the run step
 * completes only when `ingest_tacho_events` accepts the organization's first
 * frame, so a caller that asks for it is refused with `conflict:
 * first_frame_required`, and a gate that is already open refuses every
 * transition with `conflict: already_unlocked`.
 *
 * Scoped to the gate's workspace. Roles: org Owner or Admin, checked by the
 * handler (INV-29), so the caller is a signed-in user: the API surface only.
 * The MCP context carries an API key and no user, and `assertOrgRole`
 * refuses it before any read. A settings write: `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { onboardingStepSchema } from "./onboarding.state.get";

export const onboardingAdvance = registerCapability({
  name: "advance_onboarding",
  domain: "onboarding",
  description:
    "Move the onboarding gate between the wrap and run steps. The run step completes only on the first frame, so unlocked is never a target.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      /** `unlocked` is accepted by the schema and refused by the handler, so the refusal is a recorded decision. */
      to: z.enum(["wrap", "run", "unlocked"]),
    })
    .strict(),
  output: z
    .object({
      step: onboardingStepSchema,
      changedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
});

export type OnboardingAdvanceInput = z.output<typeof onboardingAdvance.input>;
export type OnboardingAdvanceOutput = z.output<typeof onboardingAdvance.output>;
