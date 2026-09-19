/**
 * `update_profile`: the Account dialog's identity fields — display name and
 * avatar. The rebuilt app has no write seam onto `auth.users` (its one
 * `withSystemDb` read, `apps/app/src/server/tenancy-lookups.ts`, is
 * column-gated to `id`/`twoFactorEnabled`), where the retired app wrote the
 * row directly from a server action. Every write in the rebuilt app goes
 * through `kernelWrite(contract)`, so this had to become a real capability —
 * which also puts a person's own name and avatar under IAM, audit,
 * `check:manifest` and `check:ui-parity` instead of being invisible to all
 * three.
 *
 * The input carries no user id: the handler acts on the authenticated
 * principal only. A capability that took a target user id here would be a
 * privilege-escalation surface — nothing about "change my own display name"
 * needs one.
 *
 * User-global, so `scoped: false`: `auth.users` has no org_id/workspace_id
 * and is not under RLS, and identity follows the person across
 * organisations, same reasoning as `set_preferences`.
 *
 * A settings write is never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true`.
 *
 * API only, no MCP surface. MCP authenticates with an API key and
 * `resolveMcpContext` (`apps/mcp/src/context.ts`) builds every context with
 * `userId: null` — machine credentials carry no person. "Change my own name"
 * has no meaning for an API key, so an MCP tool here could only ever return
 * `forbidden`/`no_principal`. Advertising a tool that cannot succeed is worse
 * than not advertising one; the surface returns if and when MCP grows a
 * session principal.
 *
 * `defaultEffect: "allow"`, because a person is never the wrong person to be.
 * On an enterprise org (the only tier the resolver runs for — `checkIAM`
 * fast-paths everything else to an unconditional allow for a non-agent
 * principal) a role map is the only thing standing between a member and their
 * own name, and the four system org roles are Owner, Admin, **Compliance** and
 * **Billing**: there is no org-level Member or Viewer. This map named the two
 * that do not exist and omitted the two that do, so `iam-provision` — which
 * iterates the real role list and reads the map by name — seeded grants for
 * Owner and Admin alone. A Compliance or Billing member opening the Account
 * dialog every other member sees was refused on their own profile.
 *
 * Listing the missing roles would fix today and go stale the day a fifth role
 * is added. `defaultEffect` does not: it is rule 8 of the resolver, which is
 * role-agnostic, so no future role can fall through it. Explicit denial still
 * wins — rule 7 evaluates role grants deny-first and hard-stops, well before
 * rule 8 is reached (`packages/oxagen/src/iam/resolve.ts`) — so an enterprise
 * admin who wants to freeze a role's profile can still say so. The role map is
 * corrected too, and now names exactly the real roles at each scope: it is what
 * `list_capabilities` shows an operator, and a map naming roles that do not
 * exist is a lie on an admin screen whatever the resolver does with it.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { avatarUrlSchema } from "../avatar";

const displayNameSchema = z
  .string()
  .trim()
  .min(1, "display name is required")
  .max(120, "display name must be at most 120 characters");

export const userProfileUpdate = registerCapability({
  name: "update_profile",
  domain: "user",
  description:
    "Update the calling user's own display name and avatar, and return the persisted values.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: false,
  mutates: true,
  noBillingGate: true,
  sensitivity: "low",
  defaultEffect: "allow",
  // Every system role at each scope: SystemOrgRole is Owner | Admin |
  // Compliance | Billing, SystemWorkspaceRole is Owner | Member | Viewer.
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      // Optional, so a caller may change the avatar alone. The avatar editor
      // has no name field, and `auth.users.display_name` is nullable: sending
      // the viewer's name back meant sending "" for a person who has never
      // set one, which this schema refuses, so their avatar could never be
      // saved. A key left out is left alone; a key present is validated.
      displayName: displayNameSchema.optional(),
      avatarUrl: avatarUrlSchema.nullable().optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.displayName !== undefined || value.avatarUrl !== undefined,
      { message: "displayName or avatarUrl is required" },
    ),
  output: z
    .object({
      displayName: z.string().nullable(),
      avatarUrl: z.string().nullable(),
    })
    .strict(),
});

export type UserProfileUpdateInput = z.output<typeof userProfileUpdate.input>;
export type UserProfileUpdateOutput = z.output<typeof userProfileUpdate.output>;
