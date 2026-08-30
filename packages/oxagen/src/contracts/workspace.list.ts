import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * list_workspaces — list the workspaces inside one organization the caller can use.
 *
 * Takes an `orgSlug` (the tenant the user picked from list_orgs) and returns the
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
});

export const workspaceList = registerCapability({
  name: "list_workspaces",
  domain: "workspace",
  description:
    "List the workspaces inside an organization the authenticated user belongs to. Backs the CLI workspace picker in `oxagen init`.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  // allow by default: same reasoning as list_orgs — listing workspaces within an
  // org the caller already belongs to is a user-intrinsic right, and the handler
  // enforces membership before listing (not-a-member → error). "deny" would 403
  // any caller whose org predates this capability being seeded in role_grants,
  // which is every org that has not been re-seeded.
  defaultEffect: "allow",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Billing: "allow",
      Compliance: "allow",
      Viewer: "allow",
    },
    workspace: {},
  },
  input: z.object({
    orgSlug: z
      .string()
      .min(1)
      .describe("Slug of the organization whose workspaces to list"),
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
