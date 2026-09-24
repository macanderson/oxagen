/**
 * Pick the SSO provider for an email before /sign-in/sso looks one up
 * (ADR-145, #3740).
 *
 * Given an email or a domain and no provider id, the @better-auth/sso plugin
 * reads the provider whose domain equals it. When none does (a subdomain such
 * as `eng.acme.com`), it lists every provider and keeps the first whose domain
 * matches, in no set order. That listing used to open every organisation's
 * secrets. The adapter now strips them from a listing (./adapter.ts), so this
 * hook resolves the provider first: the most specific VERIFIED provider whose
 * domain is the email's domain or a parent of it. It writes that provider's id
 * into the request body, and the plugin then reads that one row, the only row
 * whose secrets are opened.
 *
 * When no verified provider matches, the body is left alone and the plugin
 * answers as it always has: not found, or refused for an unverified domain.
 * An explicit providerId or organizationSlug is never overridden.
 *
 * It is a plugin rather than betterAuth's top-level `hooks` option for the
 * reason require-sso-plugin.ts gives: the middleware's better-call type cannot
 * be emitted in the exported `auth` type (TS2883), so it stays module-private
 * and the plugin is widened to BetterAuthPlugin.
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { and, eq, inArray } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { emailDomain } from "./email-domain";
import { candidateDomains } from "./policy";

export const SELECT_SSO_PROVIDER_PLUGIN_ID = "oxagen-select-sso-provider";

export interface VerifiedSsoProvider {
  readonly providerId: string;
  readonly domain: string;
}

/** The verified providers whose domain is one of `domains`. */
export type VerifiedSsoProviderLookup = (
  domains: readonly string[],
) => Promise<readonly VerifiedSsoProvider[]>;

/** The production lookup. Selects only the id and domain, never a config. */
export async function pgVerifiedSsoProviderLookup(
  domains: readonly string[],
): Promise<readonly VerifiedSsoProvider[]> {
  // tenancy: system bypass during sign-in bootstrap, before any session exists; the lookup is filtered by the email domain the person typed and returns only verified provider ids.
  return withSystemDb((tx) =>
    tx
      .select({
        providerId: schema.ssoProviderTable.providerId,
        domain: schema.ssoProviderTable.domain,
      })
      .from(schema.ssoProviderTable)
      .where(
        and(
          inArray(schema.ssoProviderTable.domain, [...domains]),
          eq(schema.ssoProviderTable.domainVerified, true),
        ),
      ),
  );
}

/**
 * The id of the most specific verified provider for `domain`: an exact match
 * wins over `acme.com`, which wins over nothing. Null when none matches.
 */
export async function selectVerifiedSsoProvider(
  domain: string,
  lookup: VerifiedSsoProviderLookup,
): Promise<string | null> {
  const candidates = candidateDomains(domain.trim().toLowerCase());
  if (candidates.length === 0) return null;
  const rows = await lookup(candidates);
  let best: VerifiedSsoProvider | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    // candidateDomains lists the domain first, then each parent, so a lower
    // index is a more specific match. A row outside the list is ignored.
    const rank = candidates.indexOf(row.domain.toLowerCase());
    if (rank >= 0 && rank < bestRank) {
      best = row;
      bestRank = rank;
    }
  }
  return best?.providerId ?? null;
}

interface SignInSsoBody {
  email?: unknown;
  domain?: unknown;
  providerId?: unknown;
  organizationSlug?: unknown;
  organizationId?: unknown;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The domain to route by, or null when the body already names a provider. */
export function routingDomain(body: SignInSsoBody | undefined): string | null {
  if (!body) return null;
  if (
    nonEmpty(body.providerId) ||
    nonEmpty(body.organizationSlug) ||
    nonEmpty(body.organizationId)
  ) {
    return null;
  }
  // The plugin routes by `domain` before the email, and so does this hook.
  if (nonEmpty(body.domain)) return body.domain.trim().toLowerCase();
  if (nonEmpty(body.email)) return emailDomain(body.email);
  return null;
}

export function selectSsoProviderPlugin(
  opts: { lookup?: VerifiedSsoProviderLookup } = {},
): BetterAuthPlugin {
  const lookup = opts.lookup ?? pgVerifiedSsoProviderLookup;
  const selectProvider = createAuthMiddleware(async (ctx) => {
    const body = ctx.body as SignInSsoBody | undefined;
    const domain = routingDomain(body);
    if (!domain) return;
    const providerId = await selectVerifiedSsoProvider(domain, lookup);
    if (!providerId) return;
    return { context: { body: { ...body, providerId } } };
  });
  return {
    id: SELECT_SSO_PROVIDER_PLUGIN_ID,
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-in/sso",
          handler: selectProvider,
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
