// The Organization view models (ARCHITECTURE.md §1.2, §3.3): People, the
// organization's members and its pending invitations read from
// list_members {scope:"org"}, and API keys, the keys the organization holds
// read from list_api_keys. Fields are nullable exactly where the contract may
// not record them: a member's display name, an invitation's expiry, and a
// key's last use, expiry and revocation.
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
});
export type ApiKey = z.infer<typeof ApiKey>;

export const ApiKeyList = z.array(ApiKey);
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
