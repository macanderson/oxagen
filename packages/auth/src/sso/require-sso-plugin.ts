/**
 * "Require SSO" at sign-in, as a Better Auth plugin (ADR-142).
 *
 * A password sign-in, or a Google/GitHub sign-in, for an email whose domain
 * belongs to an organisation that requires SSO is refused, unless the person
 * is an Owner of that organisation (break-glass, see ./policy.ts). The app's
 * org gate enforces the same policy on sessions that already exist.
 *
 * It is a plugin rather than betterAuth's top-level `hooks` option so the
 * middleware types stay inside it: the exported `auth` type would otherwise
 * name better-call's MiddlewareInputContext, which TypeScript cannot emit
 * (TS2883), the same reason twoFactor() is widened to BetterAuthPlugin.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import {
  SSO_REQUIRED_CODE,
  SSO_REQUIRED_MESSAGE,
  isNonSsoSignInRefused,
} from "./policy";

export const REQUIRE_SSO_PLUGIN_ID = "oxagen-require-sso";

/** Refuse a password sign-in into a domain that requires SSO. */
export const refusePasswordSignIn = createAuthMiddleware(async (ctx) => {
  const email = (ctx.body as { email?: unknown } | undefined)?.email;
  if (typeof email !== "string") return;
  if (await isNonSsoSignInRefused(email)) {
    throw new APIError("FORBIDDEN", {
      code: SSO_REQUIRED_CODE,
      message: SSO_REQUIRED_MESSAGE,
    });
  }
});

/** End a social sign-in into a domain that requires SSO. */
export const endSocialSignIn = createAuthMiddleware(async (ctx) => {
  const created = ctx.context.newSession;
  if (!created?.user?.email) return;
  if (!(await isNonSsoSignInRefused(created.user.email))) return;
  await ctx.context.internalAdapter.deleteSession(created.session.token);
  deleteSessionCookie(ctx);
  throw ctx.redirect("/login?sso=required");
});

export function requireSsoPlugin(): BetterAuthPlugin {
  return {
    id: REQUIRE_SSO_PLUGIN_ID,
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-in/email",
          handler: refusePasswordSignIn,
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path?.startsWith("/callback/") ?? false,
          handler: endSocialSignIn,
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
