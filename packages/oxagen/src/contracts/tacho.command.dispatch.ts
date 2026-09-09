/**
 * Send a control command to a Tacho host or one of its sessions
 * (docs/specs/tacho/spec.md section 7.4): pause, resume, cancel, message,
 * revoke, refresh_bundle, kill. The command is queued; the host receives it
 * in its next ingest response or command fetch and reports the outcome.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  hostEnrollmentIdSchema,
  tachoCommandOutcomeSchema,
  tachoCommandSchema,
} from "../tacho/schemas";

export const tachoCommandDispatch = registerCapability({
  name: "dispatch_tacho_command",
  domain: "tacho",
  description:
    "Queue a pause, resume, cancel, message, revoke, refresh_bundle, or kill command for a Tacho host or session.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      hostEnrollmentId: hostEnrollmentIdSchema,
      sessionUuid: z.string().uuid().optional(),
      command: tachoCommandSchema,
      /** `message` carries `{ text }`; `pause` and `cancel` may carry `{ reason }`. */
      payload: z.record(z.string(), z.unknown()).default({}),
      expiresInS: z.number().int().min(10).max(86_400).default(3600),
    })
    .strict(),
  output: z
    .object({
      commandId: z.string().min(1),
      outcome: tachoCommandOutcomeSchema,
      issuedAt: z.string(),
      expiresAt: z.string(),
    })
    .strict(),
});

export type TachoCommandDispatchInput = z.output<
  typeof tachoCommandDispatch.input
>;
export type TachoCommandDispatchOutput = z.output<
  typeof tachoCommandDispatch.output
>;
