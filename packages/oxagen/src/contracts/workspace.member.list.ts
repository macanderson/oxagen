import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * list_members — the members of the organization, with its pending
 * invitations, or the members of the request's workspace.
 *
 * Spec Appendix E names this tool `list_members` ("members with roles at
 * either scope"); it absorbs the former `list_workspace_members`, whose
 * `workspace_id` input every surface ignored (members were always listed for
 * the workspace the request was scoped to). The file keeps its dotted stem
 * under the ADR-025 file-path realignment.
 *
 * The scope is an argument. `org` answers the Organization › People page:
 * every membership row of the org joined to its user, plus every pending,
 * invitation, including expired ones that can be renewed. `workspace` answers the existing API and MCP callers,
 * which pass no scope: the members of the workspace the request is scoped
 * to. A workspace has no invitations of its own (invitations are org rows),
 * so the workspace branch of the output carries none.
 *
 * A console read is never a governed action (ADR-052 exclusion 2, apps/app
 * ARCHITECTURE.md §1.5): `noBillingGate` keeps a page load off the billing
 * gate and out of the recorder, and `mutates: false` is what lets the app's
 * read path bind it (`capabilityMutates` treats an absent flag as mutating).
 */
const memberSchema = z.object({
  id: z.string().describe("The member's public user id (usr_…)"),
  name: z
    .string()
    .nullable()
    .describe("Display name, or null when the user never set one"),
  avatarUrl: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "An https URL or a designed avatar:v1: value, or null when the user set none",
    ),
  email: z.string(),
  // Free-form on the wire: the membership tables CHECK the role set
  // case-insensitively and rows exist in both casings, so a read returns the
  // stored value. The enum is enforced where a role is written.
  role: z.string(),
  joinedAt: z.string().describe("ISO 8601"),
});

const invitationSchema = z.object({
  id: z.string().describe("The invitation's public id (invi_…)"),
  email: z.string(),
  role: z.string().describe("The org role the invitee receives on accept"),
  invitedAt: z.string().describe("ISO 8601"),
  expiresAt: z
    .string()
    .nullable()
    .describe("ISO 8601, or null for an invitation that never expires"),
});

export const listMembers = registerCapability({
  name: "list_members",
  domain: "org",
  description:
    "List the members of the organization with its pending invitations, or the members of the current workspace.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "organization",
  },
  sensitivity: "low",
  // Any member of the org may read its roster, the way any member may list
  // the orgs and workspaces they belong to (org.list, workspace.list). The
  // tenant scope the surface established is what bounds the read; the IAM
  // role set has no org "Member" role to grant, so a deny default would
  // refuse every plain member of an enterprise org.
  defaultEffect: "allow",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
    },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    scope: z
      .enum(["org", "workspace"])
      .default("workspace")
      .describe(
        "`org` lists the organization's members and pending invitations; `workspace` (the default, and what callers that pass nothing get) lists the members of the workspace the request is scoped to.",
      ),
  }),
  output: z.discriminatedUnion("scope", [
    z.object({
      scope: z.literal("org"),
      members: z.array(memberSchema),
      invitations: z.array(invitationSchema),
    }),
    z.object({
      scope: z.literal("workspace"),
      members: z.array(memberSchema),
    }),
  ]),
});

export type ListMembersInput = z.output<typeof listMembers.input>;
export type ListMembersOutput = z.output<typeof listMembers.output>;
