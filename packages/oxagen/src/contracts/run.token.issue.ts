import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * The trust boundary today: any workspace Member can mint an evidence
 * credential for ANY unsealed attempt in the workspace. A V2 run row carries
 * the operator who delegated it (`agent_runs.initiating_principal_id`) and
 * the agent principal acting for them (`agent_principal_id`), but the handler
 * (`packages/handlers/src/run.token.issue.ts`) does not compare the caller to
 * either. The row is the record the check would read; the check is not yet
 * written. Until it is, a Member with no part in a run can write frames into
 * it, and the seal records those frames as the run's own evidence. Follow-up:
 * refuse a caller who is neither the initiating principal nor an Owner or
 * Admin when the run carries a principal, and keep the current role gate for
 * V1 rows, which carry none.
 */
export const runTokenIssue = registerCapability({
  name: "create_run_token",
  domain: "run",
  description:
    "Issue a fifteen-minute evidence credential for one existing run attempt.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      runId: z.string().regex(/^arun_[a-zA-Z0-9]+$/),
      attemptId: z.string().regex(/^arat_[a-zA-Z0-9]+$/),
    })
    .strict(),
  output: z
    .object({ token: z.string(), expiresAt: z.string().datetime() })
    .strict(),
});
