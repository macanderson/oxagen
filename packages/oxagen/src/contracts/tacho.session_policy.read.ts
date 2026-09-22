import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * A model pattern the workspace names. Matched case-insensitively against the
 * `model` the harness asked for; a trailing `*` matches by prefix, so
 * `claude-opus-*` covers every dated build of that model. No other wildcard is
 * honoured, because the host has to apply this rule with no glob library — it
 * is a leaf package with no `@oxagen/*` runtime dependency.
 */
export const tachoModelPatternSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^(?:[A-Za-z0-9._:/-]+\*?|\*)$/,
    "a model id, optionally ending in * to match by prefix",
  );

export const tachoSessionPolicyMode = z.enum(["observed", "enforced"]);

export const tachoSessionPolicyRead = registerCapability({
  name: "get_tacho_session_policy",
  domain: "tacho",
  description:
    "Read the workspace's policy for wrapped-harness sessions — the Claude Code and Codex sessions that route their model calls through the loopback gateway. Returns the mode, the per-session dollar ceiling, and the model allow and deny lists. Nothing reads this policy yet, so it records a decision rather than what a machine refuses. Readable by every member.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  // A settings read is never a governed action (ADR-052 exclusion 2).
  noBillingGate: true,
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow", Viewer: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z.object({}),
  output: z.object({
    /**
     * "observed" = meter only, and the only value the write accepts today.
     * "enforced" stays in the enum for rows written before it was refused,
     * and for the clause the gateway will read.
     */
    mode: tachoSessionPolicyMode,
    /** The per-session ceiling in USD; null when no ceiling is set. */
    sessionLimitUsd: z.number().nullable(),
    /**
     * The models the workspace permits. `null` = no allowlist, so every model
     * is permitted; `[]` = an allowlist that permits nothing. The two are
     * different decisions and do not share an encoding.
     */
    modelAllow: z.array(tachoModelPatternSchema).nullable(),
    /** Models refused whatever the allowlist says. A deny beats an allow. */
    modelDeny: z.array(tachoModelPatternSchema),
  }),
});

export type TachoSessionPolicyReadOutput = z.output<
  typeof tachoSessionPolicyRead.output
>;
