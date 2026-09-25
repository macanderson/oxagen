import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * workspace.list — list the workspaces inside one organization the caller can use.
 *
 * Takes an `orgSlug` (the tenant the user picked from org.list) and returns the
 * org's workspaces so the CLI linker can present the workspace picker. Unscoped +
 * user-level: at link time the user has chosen an org but not yet a workspace, so
 * this runs under the auth-only /v1 user group. The handler verifies the caller
 * is a member of the org (via withSystemDb) before listing — a non-member gets a
 * not-a-member error, never another tenant's workspaces.
 *
 * A project links to exactly one workspace; this is how the user finds it.
 */
export const workspaceListItemSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  slug: z.string(),
  // Immutable namespace, unique within the org (the middle agentKey segment).
  namespace: z.string(),
  name: z.string(),
  role: z
    .string()
    .nullable()
    .describe(
      "The caller's workspace role, or null when they are an org admin without a direct workspace membership",
    ),
  archivedAt: z
    .string()
    .nullable()
    .describe(
      "ISO-8601 when the workspace was archived (archive_workspace); null while active. Present only when includeArchived is true",
    ),
  costCenter: z
    .string()
    .nullable()
    .describe(
      "The cost-center label this workspace's spend is charged back to (set_cost_center); null when it names none",
    ),
});

export const workspaceList = registerCapability({
  name: "list_workspaces",
  domain: "workspace",
  description:
    "List the workspaces inside an organization the authenticated user belongs to. Backs the CLI workspace picker in `oxagen init`.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  mutates: false,
  // A console read is never a governed action (ADR-052 exclusion 2); the
  // app's shell reads this list from an org context on every page load.
  noBillingGate: true,
  // allow by default: same reasoning as org.list — listing workspaces within an
  // org the caller already belongs to is a user-intrinsic right. The handler
  // enforces membership before listing (not-a-member → error). Keeping this as
  // "deny" caused no_grant 403s for Enterprise callers whose org was created
  // before workspace.list was seeded in role_grants. (OXA fix — CLI picker 403.)
  defaultEffect: "allow",
  // Every role a person can hold, for the reason org.list gives: "Member"
  // and "Viewer" are workspace roles, not org roles (#4194).
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
    },
    workspace: {
      Owner: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z.object({
    orgSlug: z
      .string()
      .min(1)
      .describe("Slug of the organization whose workspaces to list"),
    includeArchived: z
      .boolean()
      .default(false)
      .describe(
        "Also list archived workspaces (the Organization › Workspaces section); the switcher and the CLI picker leave this off",
      ),
  }),
  output: z.object({
    organization: z.object({
      id: z.string(),
      publicId: z.string(),
      slug: z.string(),
      namespace: z.string(),
      name: z.string(),
    }),
    workspaces: z.array(workspaceListItemSchema),
  }),
});

export type WorkspaceListItem = z.output<typeof workspaceListItemSchema>;
export type WorkspaceListInput = z.output<typeof workspaceList.input>;
export type WorkspaceListOutput = z.output<typeof workspaceList.output>;
