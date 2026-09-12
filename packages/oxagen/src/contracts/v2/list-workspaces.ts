import { z } from "zod";
import { defineTool } from "./_define";
import { workspaceList } from "../workspace.list";
import { orgList } from "../org.list";

/**
 * Appendix E: `list_workspaces` — "scoped listing". Absorbs `list_workspaces`
 * and `list_orgs`.
 *
 * The two v1 contracts are one question asked at two depths, and the CLI linker
 * (`oxagen login` / `oxagen init`) already asked both in sequence: list my
 * tenants, then list the workspaces in the one I picked. Folding them costs one
 * optional argument and saves a round trip on every link.
 *
 * `orgSlug` carries `list_workspaces`' field, made optional: omit it and the
 * answer is the caller's organizations (what `list_orgs` returned); supply it
 * and the answer also carries that organization and its workspaces. Both
 * halves of the output are always present and never null-when-empty, so a
 * caller never branches on shape — only on emptiness.
 */
export const listWorkspaces = defineTool({
  name: "list_workspaces",
  domain: "workspace",
  description:
    "List what the authenticated user can reach: their organizations, and — when an orgSlug is given — that organization's workspaces with the caller's role in each. Backs the CLI tenant and workspace pickers.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  /**
   * Carried from both sources, and load-bearing: a freshly-authenticated user
   * has selected neither tenant nor workspace, so this is the one call that has
   * to work BEFORE a scope exists. Both handlers read only the caller's own
   * memberships.
   */
  scoped: false,

  absorbs: ["list_workspaces", "list_orgs"],
  // `list_orgs` took no input, and every output field of both contracts is
  // carried by reference (the two row schemas are exported and reused whole).
  drops: [],

  // The two sources agree on every risk field.
  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  /**
   * `allow`, carried from both. The comment on each source is a production
   * scar worth keeping: default-deny here produced `no_grant` 403s for
   * Enterprise callers whose org predated the contract being seeded into
   * `role_grants`, and the resolver correctly fell through to this value.
   * Listing your own memberships is a user-intrinsic right; the handler
   * enforces that "your own" means your own.
   */
  defaultEffect: "allow",
  defaultRoles: {
    // Both sources also listed org Member and Viewer. Neither is a
    // `SystemOrgRole` (Owner | Admin | Compliance | Billing), so those entries
    // were unreachable; `defaultEffect: "allow"` is what actually admits them.
    org: {
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
    },
    workspace: {},
  },
  // Both sources declare `mutates: false`; both handlers are membership reads.
  mutates: false,

  input: z.object({
    /**
     * Carried from `list_workspaces` and made optional: absent is the
     * `list_orgs` question. Its `.describe()` travels with it, so the CLI's
     * generated help still explains what the slug selects.
     */
    orgSlug: workspaceList.input.shape.orgSlug.optional(),
  }),

  output: z.object({
    /**
     * Always answered — the tenant picker's list. Carried whole from
     * `list_orgs`, so `orgListItemSchema`'s namespace-vs-slug distinction
     * (immutable identifier vs renameable label) stays documented at the field.
     */
    organizations: orgList.output.shape.organizations,

    /**
     * The organization `orgSlug` resolved to, or null when none was given.
     * Carried from `list_workspaces`, which returned it so the caller could
     * confirm which tenant answered before it stored a workspace id against it.
     */
    organization: workspaceList.output.shape.organization.nullable(),

    /** Empty when no `orgSlug` was given. Carried whole from `list_workspaces`. */
    workspaces: workspaceList.output.shape.workspaces,
  }),
});

export type ListWorkspacesInput = z.output<typeof listWorkspaces.input>;
export type ListWorkspacesOutput = z.output<typeof listWorkspaces.output>;
