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
 * **API only, deliberately.** The handler acts on `ctx.userId` and nothing
 * else, and MCP has no user principal to give it: `resolveMcpContext`
 * (`apps/mcp/src/context.ts`) authenticates an API key and builds its context
 * with `userId: null`, and rejects a session token outright ("there is no
 * legitimate MCP use case for session-token auth"). An `update_profile` MCP
 * tool could therefore only ever answer `forbidden`/`no_principal`, so it is
 * not advertised at all. Nor is the alternative honest: resolving the acting
 * user from the key's creator (`resolveActingUserId`, the seam
 * `workspace.create` and `agent.register` use for attribution) would let a
 * machine credential rewrite the display name and avatar of the person who
 * minted it — an impersonation seam in the identity the fleet record and the
 * audit log render. A person changes their own name from a session, over the
 * API or in the app. This capability carries no `cli` surface for the same
 * reason.
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
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow", Viewer: "allow" },
    workspace: {
      Owner: "allow",
      Admin: "allow",
      Member: "allow",
      Viewer: "allow",
    },
  },
  input: z
    .object({
      displayName: displayNameSchema,
      avatarUrl: avatarUrlSchema.nullable(),
    })
    .strict(),
  output: z
    .object({
      displayName: z.string(),
      avatarUrl: z.string().nullable(),
    })
    .strict(),
});

export type UserProfileUpdateInput = z.output<typeof userProfileUpdate.input>;
export type UserProfileUpdateOutput = z.output<typeof userProfileUpdate.output>;
