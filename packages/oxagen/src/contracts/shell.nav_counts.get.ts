/**
 * `get_nav_counts`: the sidebar's counts (MC spec App. E; mockups
 * `pages/shell.md`): Fleet = pending approvals plus open interjections,
 * Steering = open proposals, Audit = open critical incidents in the
 * organization. Each count reads the store that owns it
 * (`agent.approval_requests`, `agent.interjections`, `agent.context_proposals`,
 * `tacho.incidents`).
 * A count is null only when its read answered no row, and a null renders as
 * "not recorded", never as a zero.
 *
 * A console read is never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

const count = z.number().int().nonnegative().nullable();

export const shellNavCountsGet = registerCapability({
  name: "get_nav_counts",
  domain: "shell",
  description:
    "The sidebar's counts for this workspace: pending approvals, open agent questions, open steering proposals and open critical incidents, each null when its read answered nothing.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}).strict(),
  output: z
    .object({
      /** Pending, unexpired approvals in the workspace. */
      approvals: count,
      /**
       * Questions agents in the workspace paused to ask that nobody has
       * answered and that have not expired (#3839).
       */
      interjections: count,
      /** Steering proposals that have not merged and were not rejected. */
      proposals: count,
      /** Unresolved incidents at severity 10 across the organization: Audit is an organization page. */
      incidents: count,
    })
    .strict(),
});
