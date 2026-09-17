import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * archive_workspace — archive a workspace (issue #2964).
 *
 * Archiving records `archived_at` and who archived it. From then on the
 * workspace leaves `list_workspaces` (the switcher and the CLI picker) unless
 * the caller asks for archived rows; its runs, frames and records stay
 * readable and its slug stays taken. The handler refuses a workspace already
 * archived (`conflict`, `already_archived`), one with a registered agent
 * (`conflict`, `workspace_has_agents`; the seeded `qa-chat` agent does not
 * count) and one that is not in the org (`not_found`). The kernel does not
 * refuse runs in an archived workspace. Recorded as the `workspace.archived`
 * security event.
 */
export const workspaceArchive = registerCapability({
  name: "archive_workspace",
  domain: "workspace",
  description:
    "Archive a workspace: it leaves the workspace lists, its slug stays taken and everything recorded in it stays readable. Refused when already archived or while an agent is registered in it; deregister or move those agents first.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  // A settings write, never a governed action (ADR-052 exclusion 2; INV-28).
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "workspace" },
  sensitivity: "high",
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    workspaceId: z
      .string()
      .startsWith("wrk_")
      .describe("Public workspace id (wrk_…)"),
  }),
  output: z.object({
    id: z.string().describe("Public workspace id"),
    slug: z.string(),
    name: z.string(),
    archivedAt: z.string().describe("ISO-8601"),
  }),
});

export type WorkspaceArchiveInput = z.output<typeof workspaceArchive.input>;
export type WorkspaceArchiveOutput = z.output<typeof workspaceArchive.output>;
