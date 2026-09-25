/**
 * `list_recent_runs`: the ⌘K Runs group (MC spec App. E; Mockups
 * `origin/main` `mc.html` 12050-12138). The newest runs of the workspace,
 * a fixed handful with the fields a menu row shows, read through the same
 * page as `list_runs` so the in-app agent's own turns stay out of it.
 *
 * Deliberately not `list_runs` with a small limit: the menu shows an id, an
 * agent, a status and a start time, and a contract that returned the
 * Fleet row would make the menu a second consumer of fourteen fields it
 * never renders. A console read is never a governed action (ADR-052
 * exclusion 2): `noBillingGate: true`.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema, runStatusSchema } from "./run.list";

export const RECENT_RUNS_MAX = 10;

export const recentRunSchema = z
  .object({
    id: runPublicIdSchema,
    /** `org_ns.ws_ns.slug`; null when the ledger row names no agent. */
    agentKey: z.string().nullable(),
    status: runStatusSchema,
    /** RFC 3339. */
    startedAt: z.string().datetime(),
  })
  .strict();

export const runRecentList = registerCapability({
  name: "list_recent_runs",
  domain: "run",
  description:
    "The newest runs of this workspace for the command menu: id, agent key, status and start time, the in-app agent's own turns excluded.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "run" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      limit: z.number().int().min(1).max(RECENT_RUNS_MAX).default(8),
    })
    .strict(),
  output: z
    .object({
      runs: z.array(recentRunSchema).max(RECENT_RUNS_MAX),
    })
    .strict(),
});

export type RunRecentListInput = z.output<typeof runRecentList.input>;
export type RunRecentListOutput = z.output<typeof runRecentList.output>;
