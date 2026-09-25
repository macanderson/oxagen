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
    "Set the workspace model allow and deny lists for routed calls from upgraded hosts. Enforced mode arms model restrictions independently of agent budgets. The legacy workspace dollar ceiling is recorded only. Omitted fields stay unchanged. Owner/Admin only.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  // `requiresApproval: true`, like `update_mandate_limits`, `set_kill_switch`
  // and `set_approval_rule`: an agent that asks to raise its own session
  // ceiling or widen the models it may call waits for a person. The model lists are independent of the agent budget.
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "workspace",
  },
  sensitivity: "medium",
  mutates: true,
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
      /** Of those, the ones that advertised independent model enforcement. */
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
