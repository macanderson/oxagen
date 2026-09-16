// The Organization view models (ARCHITECTURE.md §1.2, §3.3): People from
// list_members {scope:"org"}, the role and permission catalogue from
// list_iam_roles, and the organization's workspaces from list_workspaces.
// Fields are nullable exactly where the contract may not record them: a
// member's display name, an invitation's expiry, a role's description and
// author, a workspace role the viewer does not hold, and an archival date a
// live workspace has not got.
import { z } from "zod";
import { PublicId, StoredOrgRole } from "./common";

const Member = z.object({
  id: PublicId,
  name: z.string().nullable(),
  email: z.string().min(1),
  role: StoredOrgRole,
  joinedAt: z.iso.datetime(),
});

const Invitation = z.object({
  id: PublicId,
  email: z.string().min(1),
  role: StoredOrgRole,
  invitedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});

export const MemberList = z.object({
  members: z.array(Member),
  invitations: z.array(Invitation),
});
export type MemberList = z.infer<typeof MemberList>;

/**
 * One entry of the permission catalogue (ADR-063): a named bundle of
 * registered capabilities in one of the catalogue's groups. The catalogue id
 * is `permission`, not `id`: it is `run.read`, a vocabulary word, never a
 * public id (INV-11).
 */
const Permission = z.object({
  permission: z.string().min(1),
  group: z.string().min(1),
  description: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
});

/** A role of the organization, folded from its grants into catalogue permissions. */
const Role = z.object({
  id: PublicId,
  name: z.string().min(1),
  description: z.string().nullable(),
  scope: z.enum(["org", "workspace"]),
  /** human for the seeded membership roles; agent for every custom role. */
  kind: z.enum(["human", "agent"]),
  /** A seeded role: read-only in the editor, and never deleted. */
  builtIn: z.boolean(),
  /** Catalogue permission ids the role allows every capability of. */
  permissions: z.array(z.string().min(1)),
  heldBy: z.number().int().nonnegative(),
  /** The display name of whoever created a custom role, when it was recorded. */
  createdBy: z.string().nullable(),
});

export const RoleCatalog = z.object({
  roles: z.array(Role),
  catalog: z.array(Permission),
  /**
   * Whether the kernel's IAM check runs the resolver for this organization
   * (ARCHITECTURE.md §1.5). False means every capability is allowed whatever
   * a role says, and the page says so.
   */
  enforcement: z.object({
    tier: z.string().min(1),
    enforced: z.boolean(),
  }),
});
export type RoleCatalog = z.infer<typeof RoleCatalog>;
export type Role = z.infer<typeof Role>;
export type Permission = z.infer<typeof Permission>;

const Workspace = z.object({
  id: PublicId,
  slug: z.string().min(1),
  name: z.string().min(1),
  /** The viewer's role in this workspace; null for an org admin with no membership of it. */
  role: z.string().nullable(),
  /** When the workspace was archived; null while it is live. */
  archivedAt: z.iso.datetime().nullable(),
});

export const WorkspaceList = z.object({ workspaces: z.array(Workspace) });
export type WorkspaceList = z.infer<typeof WorkspaceList>;
export type Workspace = z.infer<typeof Workspace>;
