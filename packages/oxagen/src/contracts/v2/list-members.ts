import { z } from "zod";
import { defineTool } from "./_define";
import { workspaceMemberList } from "../workspace.member.list";

/**
 * Appendix E: `list_members` — "members with roles at either scope". Absorbs
 * `list_workspace_members`.
 *
 * One absorbed source, but not a 1:1 carry, because Appendix E widens the job:
 * the same tool must now answer at org scope, which `list_workspace_members`
 * could not do at all. Three changes, each declared:
 *
 * 1. `scope` replaces `workspace_id` as the thing that selects what is listed.
 * 2. The output is an object, not a bare array. A top-level array cannot say
 *    which scope answered, and it cannot grow a cursor later without breaking
 *    every caller — the two org-scoped list contracts this batch also carries
 *    (`list_orgs`, `list_workspaces`) both learned that already.
 * 3. Field names are camelCase, matching every other contract in this group.
 */
const memberRow = workspaceMemberList.output.element.shape;

export const listMembers = defineTool({
  name: "list_members",
  domain: "org",
  description:
    "List the members of the organization or of a workspace, with each member's role and join date.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,

  absorbs: ["list_workspace_members"],
  drops: [
    {
      field: "workspace_id",
      from: "list_workspace_members",
      why: "replaced by `scope` + `workspaceId`: the snake_case spelling is not house casing (ADR-025 sibling rule), and on its own the field could not express an org-scope listing, which is the half Appendix E adds",
    },
    {
      field: "joined_at",
      from: "list_workspace_members",
      why: "renamed to `joinedAt`; same value, same ISO-8601 encoding — the snake_case pair in this contract was the outlier, not the convention",
    },
  ],

  agent: { requiresApproval: false, riskLevel: "low", category: "workspace" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    // v1 also listed workspace "Admin", which is not a `SystemWorkspaceRole`
    // (Owner | Member | Viewer) and so was unreachable. Owner and Member carry.
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * `false`, confirmed against packages/handlers/src/workspace.member.list.ts:
   * one `withTenantDb` select joining `workspaceUsers` to `users`, a log line,
   * and a map. No write on any path.
   */
  mutates: false,

  input: z.object({
    /** ADR-025: scope as an argument. Defaults to the caller's workspace. */
    scope: z.enum(["org", "workspace"]).default("workspace"),

    /**
     * Only meaningful at workspace scope, and only to list a workspace other
     * than the request's own. Omitted, the scope resolved from the request
     * context answers — which is what `workspace_id: optional` meant in v1.
     */
    workspaceId: z.string().optional(),
  }),

  output: z.object({
    scope: z.enum(["org", "workspace"]),
    members: z.array(
      z.object({
        id: memberRow.id,
        email: memberRow.email,
        // Free-form on the wire in both scopes: Appendix A fixes the
        // vocabularies (`org.org_users.role`, `wrk.workspace_users.role`), but
        // a READ must keep returning whatever is in the column, including a
        // legacy value an older row carries. `set_member_role` is where the
        // enum is enforced, because that is where a bad value would be written.
        role: memberRow.role,
        joinedAt: memberRow.joined_at,
      }),
    ),
  }),
});

export type ListMembersInput = z.output<typeof listMembers.input>;
export type ListMembersOutput = z.output<typeof listMembers.output>;
