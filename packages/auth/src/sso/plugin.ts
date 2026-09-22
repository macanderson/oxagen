/**
 * The @better-auth/sso plugin as Oxagen configures it (ADR-142). auth.ts and
 * the sign-in proof test both build it here, so the test signs in through the
 * configuration production runs.
 */
import { sso } from "@better-auth/sso";
import type { BetterAuthPlugin } from "better-auth";
import type { SsoProvisionInput } from "./provision";

/**
 * The plugin endpoints Oxagen does not expose. Provider CRUD and domain
 * verification are the org.sso.* capabilities: those endpoints authorise
 * against Better Auth's organization plugin, which Oxagen does not use, and
 * they would bypass the kernel's IAM, the secret sealing and the audit trail.
 * Pass these to betterAuth's `disabledPaths`.
 */
export const SSO_DISABLED_PATHS = [
  "/sso/register",
  "/sso/providers",
  "/sso/get-provider",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
] as const;

export interface OxagenSsoPluginOptions {
  /** The sign-in provisioner from createSsoProvisioner. */
  provisionUser: (input: SsoProvisionInput) => Promise<unknown>;
}

export function buildSsoPlugin(opts: OxagenSsoPluginOptions): BetterAuthPlugin {
  return sso({
    // Run the group → role mapping on EVERY sign-in, not just the first, so
    // the mapping stays authoritative (see provision.ts).
    provisionUser: async (data) => {
      await opts.provisionUser({
        user: data.user,
        userInfo: data.userInfo,
        provider: data.provider,
      });
    },
    provisionUserOnEveryLogin: true,
    // Better Auth's organization plugin is not in use; Oxagen's own
    // provisioner above owns membership. Explicit so nothing tries.
    organizationProvisioning: { disabled: true },
    // An org proves it owns the email domain before anyone signs in through
    // its provider. This is also what makes the provider "trusted" for
    // linking, so a person who already has a password account links on their
    // first SSO sign-in instead of hitting "account not linked".
    domainVerification: { enabled: true },
    // Registration happens only through the org.sso.* capabilities.
    providersLimit: 0,
    saml: {
      // Enterprise IdPs (Okta, Entra ID, OneLogin) follow SAML2Int, which
      // requires NotBefore/NotOnOrAfter. Refuse assertions without them.
      requireTimestamps: true,
      algorithms: { onDeprecated: "reject" },
    },
  }) as BetterAuthPlugin;
}
