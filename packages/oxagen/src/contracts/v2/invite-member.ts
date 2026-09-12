import { z } from "zod";
import { defineTool } from "./_define";
import { orgMemberAdd } from "../org.member.add";
import { workspaceInviteSend } from "../workspace.invite.send";

/**
 * Appendix E: `invite_member` — "invite to org or workspace with role".
 * Absorbs `send_workspace_invite` and `add_org_member`.
 *
 * Two contracts that did the same job at two scopes become one tool with the
 * scope as an argument (ADR-025). Three carry decisions worth reading:
 *
 * 1. **The role is an enum now, and which enum depends on the scope.**
 *    `add_org_member` took `role: z.string().min(1)` — any string at all, which
 *    means a typo became a membership row with a role nothing grants. Appendix
 *    A settles both vocabularies: `org.org_users.role` is owner | admin |
 *    member | billing | compliance | viewer, and `wrk.workspace_users.role` is
 *    owner | member | viewer. The spec is stricter than the code it absorbs, so
 *    the spec wins, and the cross-field rule below enforces which list applies.
 *
 * 2. **The wire shape follows the org contract.** `send_workspace_invite`
 *    returned `id` / `expires_at`; `add_org_member` returned `invitationId` /
 *    `expiresAt` plus the `status: "pending"` literal. The same three values
 *    survive under the org contract's names — see `drops`.
 *
 * 3. **The input is a ZodEffects.** The mode↔role rule cannot be expressed on
 *    the object alone, so `inviteMemberInputObject` is exported separately for
 *    surfaces that need `.shape` (the same pattern `set_data_plane` uses).
 */

/** Appendix A `org.org_users.role`. */
const orgRoleSchema = z.enum([
  "owner",
  "admin",
  "member",
  "billing",
  "compliance",
  "viewer",
]);

/** Appendix A `wrk.workspace_users.role` — a strict subset of the org list. */
const workspaceRoleSchema = z.enum(["owner", "member", "viewer"]);

export const inviteMemberInputObject = z.object({
  /**
   * ADR-025: scope is an argument, not a name. No default — an invitation sent
   * to the wrong scope is a privilege mistake that a defaulted field would make
   * silently, and the two scopes are not interchangeable (org membership is a
   * seat and a license, workspace membership is not).
   */
  scope: z.enum(["org", "workspace"]),

  // Both sources validated the address identically; carried from the org one,
  // whose handler also enforces the seat/license limit behind it.
  email: orgMemberAdd.input.shape.email,

  /**
   * Accepts the full org vocabulary; the refinement below rejects `admin`,
   * `billing` and `compliance` at workspace scope. Stated as one field rather
   * than a discriminated union so the MCP parameter schema stays flat.
   */
  role: orgRoleSchema,

  // Carried from `send_workspace_invite`: the note that rides along in the
  // invitation email. It was never scope-specific.
  message: workspaceInviteSend.input.shape.message,
});

const inviteMemberInput = inviteMemberInputObject.superRefine((value, ctx) => {
  if (
    value.scope === "workspace" &&
    !workspaceRoleSchema.safeParse(value.role).success
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["role"],
      message:
        "a workspace membership can only be owner, member, or viewer (Appendix A wrk.workspace_users.role) — admin, billing and compliance exist only at org scope",
    });
  }
});

export const inviteMember = defineTool({
  name: "invite_member",
  domain: "org",
  description:
    "Invite a person by email to the organization or to a workspace, with a role. Org invitations consume a seat and fail with a typed error when no license is available.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["send_workspace_invite", "add_org_member"],
  drops: [
    {
      field: "id",
      from: "send_workspace_invite",
      why: "same value, carried under add_org_member's name `invitationId`; Appendix E folds the workspace invite into the org contract, so the org contract's camelCase wire shape is the one that survives",
    },
    {
      field: "expires_at",
      from: "send_workspace_invite",
      why: "same value, carried as `expiresAt` (nullable, from add_org_member) for the same reason as `id`",
    },
    {
      field: "role (enum + default)",
      from: "send_workspace_invite",
      why: "its member|admin|owner enum and `member` default are replaced by Appendix A's vocabulary, which has no `admin` at workspace scope and adds `viewer`; the default is gone because a scope-dependent default cannot be expressed on the field and a silently-defaulted role is a privilege decision nobody made",
    },
  ],

  // Both sources disagree on every risk field. The stricter value wins each
  // time, and each stricter value comes from `add_org_member`: an org
  // invitation reserves a seat, provisions IAM on accept, and reaches every
  // workspace in the tenant, which is the blast radius the unified tool has.
  agent: {
    requiresApproval: true, // add_org_member (send_workspace_invite: false)
    riskLevel: "medium", // add_org_member (send_workspace_invite: "low")
    category: "organization",
  },
  sensitivity: "high", // add_org_member (send_workspace_invite: "low")
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    /**
     * The one place the strict intersection is NOT taken, deliberately.
     * `add_org_member` declares `workspace: {}`, and mechanically intersecting
     * would leave a workspace Owner unable to invite anyone into the workspace
     * they own — which §14's Organization page requires them to do.
     *
     * `{}` was never a judgment that workspace owners should not invite; it was
     * that org membership is not a workspace concept. That distinction is now
     * the `scope` argument, so it is enforced where it belongs: the handler
     * rejects `scope: "org"` from a principal holding only a workspace role.
     * v1's workspace "Admin" grant is not reproduced — there is no such system
     * role (`SystemWorkspaceRole` is Owner | Member | Viewer).
     */
    workspace: { Owner: "allow" },
  },
  mutates: true,

  input: inviteMemberInput,

  output: z.object({
    scope: inviteMemberInputObject.shape.scope,
    invitationId: orgMemberAdd.output.shape.invitationId,
    email: orgMemberAdd.output.shape.email,
    role: orgMemberAdd.output.shape.role,
    status: orgMemberAdd.output.shape.status,
    expiresAt: orgMemberAdd.output.shape.expiresAt,
  }),
});

export type InviteMemberInput = z.output<typeof inviteMember.input>;
export type InviteMemberOutput = z.output<typeof inviteMember.output>;
