import { z } from "zod";
import { registerCapability } from "../registry";
import {
  tachoModelPatternSchema,
  tachoSessionPolicyMode,
} from "./tacho.session_policy.read";

export const tachoSessionPolicyWrite = registerCapability({
  name: "update_tacho_session_policy",
  domain: "tacho",
  description:
    "Set the workspace's policy for wrapped-harness sessions — the Claude Code and Codex sessions that route their model calls through the loopback gateway. Partial update: an omitted field does not change. Sets the per-session dollar ceiling and the model allow and deny lists. Nothing reads this policy yet: no bundle carries the model lists, and a session's ceiling comes from the agent's own mandate budget, so the gateway refuses nothing whatever is saved here and `mode: \"enforced\"` is refused. Owner/Admin only.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "workspace",
  },
  sensitivity: "medium",
  noBillingGate: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    // Omit = no change.
    mode: tachoSessionPolicyMode.optional(),
    // Omit = no change; null = clear the ceiling; number = set it.
    sessionLimitUsd: z.number().positive().nullable().optional(),
    // Omit = no change; null = drop the allowlist (permit every model);
    // [] = an allowlist that permits nothing.
    modelAllow: z.array(tachoModelPatternSchema).max(256).nullable().optional(),
    // Omit = no change; [] = refuse nothing.
    modelDeny: z.array(tachoModelPatternSchema).max(256).optional(),
  }),
  output: z.object({
    mode: tachoSessionPolicyMode,
    sessionLimitUsd: z.number().nullable(),
    modelAllow: z.array(tachoModelPatternSchema).nullable(),
    modelDeny: z.array(tachoModelPatternSchema),
    /**
     * Which enrolled hosts will actually apply this, and which will not.
     *
     * `models` rides a gated bundle field, so a daemon built before the field
     * is never sent one and keeps metering without refusing. The write says so
     * rather than letting a person read a saved allowlist as an enforced one.
     */
    reach: z.object({
      /** Enrolled, non-revoked hosts in this workspace. */
      hosts: z.number().int().nonnegative(),
      /** Of those, the ones that advertised they can parse `models`. */
      hostsEnforcingModels: z.number().int().nonnegative(),
    }),
  }),
});

export type TachoSessionPolicyWriteInput = z.output<
  typeof tachoSessionPolicyWrite.input
>;
export type TachoSessionPolicyWriteOutput = z.output<
  typeof tachoSessionPolicyWrite.output
>;
