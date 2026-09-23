import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * The trust boundary. A V2 run row carries the operator who delegated it
 * (`agent_runs.initiating_principal_id`) and the agent principal acting for
 * them (`agent_principal_id`). When the row names either, the handler
 * (`packages/handlers/src/run.token.issue.ts`) refuses a caller who is
 * neither of those principals and holds neither org Owner nor Admin, so a
 * Member with no part in a run cannot write frames the seal would record as
 * the run's own evidence. A V1 row names no principal, and for it the role
 * gate below (org Owner or Admin, or workspace Owner or Member) is the whole
 * boundary. A machine key is refused before either check: a credential for a
 * run is issued from an operator's session.
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
