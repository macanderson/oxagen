import { z } from "zod";
import { defineTool } from "./_define";
import { orgMemberRoleChange } from "../org.member_role.change";
import { orgMemberRemove } from "../org.member.remove";

/**
 * Appendix E: `set_member_role` — "set a role or remove (role `none`) at org or
 * workspace". Absorbs `change_member_role` and `remove_org_member`.
 *
 * Removal is a role value, not a second tool. That is Appendix E's wording and
 * it is also the safer shape: the two v1 contracts shared a target, an
 * authorization rule, and a last-owner guard, and keeping them apart meant the
 * guard had to be written twice — once in each handler — to hold.
 *
 * The role vocabulary is Appendix A's, not v1's `z.string().min(1)`. Same
 * reasoning as `invite_member`: a free string turns a typo into a membership
 * row with a role nothing grants, and Appendix A already fixes both lists
 * (`org.org_users.role`, `wrk.workspace_users.role`). The scope↔role rule needs
 * a superRefine, so the base object is exported for surfaces needing `.shape`.
 */

const orgRoleSchema = z.enum([
  "owner",
  "admin",
  "member",
  "billing",
  "compliance",
  "viewer",
]);

const workspaceRoleSchema = z.enum(["owner", "member", "viewer"]);

export const setMemberRoleInputObject = z.object({
  /** ADR-025: scope as an argument. No default — see `invite_member`. */
  scope: z.enum(["org", "workspace"]),

  /**
   * Carried from `change_member_role`, whose `.describe()` is the accurate one
   * for the merged tool: `remove_org_member` documented the same field as "the
   * user to remove", which is now only one of the two outcomes. Both handlers
   * resolved either a `oru_`-prefixed membership id or a raw user uuid against
   * the caller's own tenant for IDOR safety; that behaviour is unchanged.
   */
  targetUserId: orgMemberRoleChange.input.shape.targetUserId,

  /**
   * `none` removes the membership — Appendix E's spelling of what
   * `remove_org_member` was. It is the only value that revokes role
   * assignments and deactivates the principal, and like every other value it
   * is refused when the target is the last owner.
   */
  role: z.union([orgRoleSchema, z.literal("none")]),
});

const setMemberRoleInput = setMemberRoleInputObject.superRefine((value, ctx) => {
  if (
    value.scope === "workspace" &&
    value.role !== "none" &&
    !workspaceRoleSchema.safeParse(value.role).success
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["role"],
      message:
        "a workspace membership can only be owner, member, viewer, or none (Appendix A wrk.workspace_users.role) — admin, billing and compliance exist only at org scope",
    });
  }
});

export const setMemberRole = defineTool({
  name: "set_member_role",
  domain: "org",
  description:
    "Set a member's role at the organization or a workspace, or remove them with role `none`. Replaces the IAM role assignment; `none` also revokes assignments and deactivates the principal. Blocked when the target is the last org owner. Audited as org.role_changed / org.member_removed.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,

  absorbs: ["change_member_role", "remove_org_member"],
  renames: [
    {
      from: "newRole",
      source: "change_member_role",
      to: "role",
      why: "the name described a contrast that no longer holds on the input. `newRole` reads as 'new' only against an old one, which was accurate while the tool did exactly one thing to an existing membership. Merging in `remove_org_member` made `none` a value of the same field, and `newRole: 'none'` names a role nobody ends up holding. Appendix E's wording for the merged tool is 'set a role or remove (role `none`)', so the input field is the role being set: `role`. The output keeps `newRole`, where the contrast with `previousRole` is exactly the point.",
    },
  ],
  // Every other input field of both sources is carried: `targetUserId` is
  // shared and taken by import, and `remove_org_member` had nothing else.
  // Both outputs carry in full too: `changed` and the previous/new role pair
  // from change_member_role, `removed` from remove_org_member, and the shared
  // target/org identifiers.
  drops: [],

  // The two sources agree on every risk field, and agree at the strict end:
  // this is the capability that can lock an organization out of itself.
  agent: { requiresApproval: true, riskLevel: "high", category: "organization" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    /**
     * Both sources declare `{}` and it is carried unchanged — unlike
     * `invite_member`, where the intersection had to be relaxed. The
     * difference: inviting into a workspace you own creates nothing outside it,
     * while a role change reaches IAM role assignments and the principal
     * itself, which are org-scoped objects (Appendix A `iam.*` are all class
     * `org`). §14 puts people and roles on the Organization page for the same
     * reason.
     */
    workspace: {},
  },
  mutates: true,

  input: setMemberRoleInput,

  output: z.object({
    scope: setMemberRoleInputObject.shape.scope,
    // Carried from `change_member_role`: true when anything actually changed,
    // false when the target already held the requested role.
    changed: orgMemberRoleChange.output.shape.changed,
    // Carried from `remove_org_member`: true only for `role: "none"`.
    removed: orgMemberRemove.output.shape.removed,
    targetUserId: orgMemberRoleChange.output.shape.targetUserId,
    orgId: orgMemberRoleChange.output.shape.orgId,
    previousRole: orgMemberRoleChange.output.shape.previousRole,
    /** The role now held, or `none` when the membership was removed. */
    newRole: setMemberRoleInputObject.shape.role,
  }),
});

export type SetMemberRoleInput = z.output<typeof setMemberRole.input>;
export type SetMemberRoleOutput = z.output<typeof setMemberRole.output>;
