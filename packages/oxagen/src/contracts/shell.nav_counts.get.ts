/**
 * `get_nav_counts`: the sidebar's three counts (MC spec App. E; Mockups
 * `origin/main` `mc.html` 3776-3813): Fleet = pending approvals, Steering =
 * proposals, Audit = open critical incidents. Each count is null when its
 * store is absent, and a null renders as no badge: rev1 has approvals
 * (`agent.approval_requests`), no proposals store until the #2961 lane
 * lands, and no incident store (Audit is cut to the archive at seal,
 * apps/app/ARCHITECTURE.md §1.2), so `proposals` and `incidents` are null
 * here and the contract says so rather than printing a zero.
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
    "The sidebar's counts for this workspace: pending approvals, open proposals and open critical incidents, each null when its store does not exist.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
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
      /** Open steering proposals; null until a proposals store exists. */
      proposals: count,
      /** Open critical incidents; null until an incident store exists. */
      incidents: count,
    })
    .strict(),
});
