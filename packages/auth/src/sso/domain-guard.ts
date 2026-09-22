/**
 * An SSO provider signs people in only for its own verified email domain
 * (ADR-142).
 *
 * The @better-auth/sso plugin's just-in-time path creates a user, or links an
 * account into one, for whatever email the identity provider asserts. It
 * checks the domain only to decide whether linking is "trusted", not whether
 * the user may exist at all. Without this guard, an org that verified
 * `evil.com` and runs its own IdP could assert `victim@gmail.com`: the plugin
 * creates a user row for that address with the attacker's SSO account on it,
 * and when the real owner later signs in with Google, Better Auth links
 * Google into the attacker's row (account pre-hijack).
 *
 * So both writes are refused before they happen, on every SSO callback and
 * ACS path:
 *   - user.create.before: the new user's email must be in the provider's
 *     verified domain (the domain itself or a subdomain of it);
 *   - account.create.before: an account for an SSO provider may be attached
 *     only to a user whose email is in that provider's verified domain,
 *     whichever path created it.
 *
 * Returning false from a Better Auth create.before hook aborts the insert;
 * the plugin then redirects with an error and no session exists.
 */
import { emailDomain } from "./email-domain";

export interface SsoProviderDomain {
  domain: string;
  domainVerified: boolean;
}

export interface SsoDomainGuardDeps {
  /** The provider's domain, or null when `providerId` is not an SSO provider. */
  lookupProvider(providerId: string): Promise<SsoProviderDomain | null>;
}

/** The Better Auth endpoint context a database hook receives, as read here. */
interface HookContext {
  path?: string;
  params?: Record<string, unknown>;
  context?: {
    internalAdapter?: {
      findUserById(id: string): Promise<{ email?: string | null } | null>;
    };
  };
}

const SSO_SIGN_IN_PATHS = [
  "/sso/callback/",
  "/sso/saml2/callback/",
  "/sso/saml2/sp/acs/",
];

/** Whether `email` belongs to `domain` or one of its subdomains. */
export function emailInSsoDomain(email: string, domain: string): boolean {
  const own = emailDomain(email);
  const bound = domain.trim().toLowerCase();
  if (!own || !bound) return false;
  return own === bound || own.endsWith(`.${bound}`);
}

function ssoProviderIdOf(ctx: HookContext | null | undefined): string | null {
  const path = ctx?.path;
  if (!path || !SSO_SIGN_IN_PATHS.some((p) => path.startsWith(p))) return null;
  const id = ctx.params?.providerId;
  // An SSO path with no provider id is refused outright by the callers: the
  // shared /sso/callback redirect is not configured, so it cannot be ours.
  return typeof id === "string" && id !== "" ? id : "";
}

async function allowed(
  deps: SsoDomainGuardDeps,
  providerId: string,
  email: string | null | undefined,
): Promise<boolean> {
  if (!providerId || !email) return false;
  const provider = await deps.lookupProvider(providerId);
  return (
    provider !== null &&
    provider.domainVerified &&
    emailInSsoDomain(email, provider.domain)
  );
}

export function createSsoDomainGuard(deps: SsoDomainGuardDeps) {
  return {
    /** databaseHooks.user.create.before */
    async userCreateBefore(
      user: { email?: string | null },
      ctx: HookContext | null | undefined,
    ): Promise<boolean | undefined> {
      const providerId = ssoProviderIdOf(ctx);
      if (providerId === null) return undefined;
      return (await allowed(deps, providerId, user.email)) ? undefined : false;
    },

    /** databaseHooks.account.create.before */
    async accountCreateBefore(
      account: { providerId?: string | null; userId?: string | null },
      ctx: HookContext | null | undefined,
    ): Promise<boolean | undefined> {
      const providerId = account.providerId;
      if (!providerId) return undefined;
      const provider = await deps.lookupProvider(providerId);
      if (provider === null) return undefined; // not an SSO provider
      if (!account.userId) return false;
      const user =
        (await ctx?.context?.internalAdapter?.findUserById(account.userId)) ??
        null;
      return provider.domainVerified &&
        user?.email &&
        emailInSsoDomain(user.email, provider.domain)
        ? undefined
        : false;
    },
  };
}
