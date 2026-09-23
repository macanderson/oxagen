// The Organization view models (ARCHITECTURE.md §1.2, §3.3): People, the
// organization's members and its pending invitations read from
// list_members {scope:"org"}; the role and permission catalogue from
// list_iam_roles; the organization's workspaces from list_workspaces; and API
// keys, the keys the organization holds, read from list_api_keys. Fields are
// nullable exactly where the contract may not record them: a member's display
// name, an invitation's expiry, a role's description and author, a workspace
// role the viewer does not hold, an archival date a live workspace has not
// got, and a key's last use, expiry and revocation.
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
  /** The cost-center label its spend is charged back to; null when it names none (ADR-142). */
  costCenter: z.string().min(1).nullable(),
});

export const WorkspaceList = z.object({ workspaces: z.array(Workspace) });
export type WorkspaceList = z.infer<typeof WorkspaceList>;
export type Workspace = z.infer<typeof Workspace>;

/**
 * One label on the organization's cost-center list (`list_cost_centers`,
 * ADR-142), with how many live agents and workspaces name it.
 */
const CostCenter = z.object({
  id: PublicId,
  label: z.string().min(1),
  description: z.string().min(1).nullable(),
  agents: z.number().int().nonnegative(),
  workspaces: z.number().int().nonnegative(),
});
export const CostCenterList = z.object({ costCenters: z.array(CostCenter) });
export type CostCenterList = z.infer<typeof CostCenterList>;
export type CostCenter = z.infer<typeof CostCenter>;
/**
 * One API key as `list_api_keys` records it (ARCHITECTURE.md §1.2 API keys
 * row): what it is called, the leading window that identifies it on sight, and
 * the four instants of its life. `lastUsedAt` is null until a request presents
 * it, `expiresAt` is null for a key with no expiry, and `revokedAt` is null for
 * a live key. The contract returns no secret and no hash — the raw key is
 * returned once by `create_api_key` and never stored — so this view model has
 * no field for either, and `api-keys.test.ts` holds it to that.
 */
export const ApiKey = z.object({
  id: PublicId,
  name: z.string().min(1),
  /** The fixed leading window of the raw key, for recognition. */
  prefix: z.string().min(1),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  /**
   * Whether `rotate_api_key` will replace this key. False for a key an
   * enrollment or a login flow owns; the handler refuses to rotate those, so
   * the page offers Revoke alone rather than a control that can only fail.
   */
  rotatable: z.boolean(),
});
export type ApiKey = z.infer<typeof ApiKey>;

export const ApiKeyList = z.array(ApiKey);

/** The vendors an organisation can bring a model key for (ADR-053 §2). */
export const ModelProvider = z.enum([
  "openrouter",
  "gateway",
  "openai",
  "anthropic",
  "openai_compatible",
]);
export type ModelProvider = z.infer<typeof ModelProvider>;

/**
 * The organisation's own model key as `get_model_credential` reports it: which
 * vendor, whether it is in use, the last four characters, the endpoint and
 * per-tier models, and when it was last tested and last changed. Never the
 * key — the contract has no field for it, and this view model has none
 * either. `configured: false` is an organisation on Oxagen's key.
 */
export const ModelCredential = z.object({
  configured: z.boolean(),
  provider: ModelProvider.nullable(),
  status: z.enum(["active", "disabled"]).nullable(),
  keyHint: z.string().nullable(),
  baseUrl: z.string().nullable(),
  modelMap: z.object({
    fast: z.string().optional(),
    balanced: z.string().optional(),
    precise: z.string().optional(),
  }),
  lastVerifiedAt: z.iso.datetime().nullable(),
  rotatedAt: z.iso.datetime().nullable(),
});
export type ModelCredential = z.infer<typeof ModelCredential>;

/**
 * The roles `change_member_role` can grant. `bootstrapOrgIAM` seeds four
 * org-scoped roles (`ORG_ROLES`, packages/handlers/src/iam-provision.ts:55-60)
 * and the handler resolves `newRole` against that set; `member` and `viewer`
 * are workspace-scoped names the roster prints for rows written by the
 * onboarding path, and no org-scoped role of either name exists to grant.
 */
export const GrantableOrgRole = z.enum([
  "owner",
  "admin",
  "billing",
  "compliance",
]);
export type GrantableOrgRole = z.infer<typeof GrantableOrgRole>;
