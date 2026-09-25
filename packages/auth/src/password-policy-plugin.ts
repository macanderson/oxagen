/**
 * The password policy at the server, as a Better Auth plugin (#3888).
 *
 * Better Auth checks only a minimum and maximum length. This plugin refuses a
 * new password that misses any rule in ./password-policy.ts before Better Auth
 * hashes it, on every endpoint that sets one: sign-up, reset, and change. The
 * refusal is a 400 with the code PASSWORD_TOO_WEAK and a message naming the
 * rule the password missed.
 *
 * It is a plugin rather than betterAuth's top-level `hooks` option for the
 * reason ./sso/require-sso-plugin.ts gives: the middleware types stay out of
 * the exported `auth` type, which TypeScript cannot emit (TS2883).
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import {
  PASSWORD_TOO_WEAK_CODE,
  passwordPolicyViolation,
} from "./password-policy";

export const PASSWORD_POLICY_PLUGIN_ID = "oxagen-password-policy";

/** Each endpoint that sets a password, and the body field that carries it. */
export const PASSWORD_FIELD_BY_PATH: Readonly<Record<string, string>> = {
  "/sign-up/email": "password",
  "/reset-password": "newPassword",
  "/change-password": "newPassword",
};

/** The body field carrying the new password at `path`, or undefined when the path sets none. */
function passwordFieldFor(path: string | undefined): string | undefined {
  if (path === undefined || !Object.hasOwn(PASSWORD_FIELD_BY_PATH, path)) {
    return undefined;
  }
  return PASSWORD_FIELD_BY_PATH[path];
}

/** Refuse a new password that misses the policy. */
const refuseWeakPassword = createAuthMiddleware(async (ctx) => {
  const field = passwordFieldFor(ctx.path);
  if (field === undefined) return;
  const value = (ctx.body as Record<string, unknown> | undefined)?.[field];
  // A missing or non-string password is left to Better Auth's own body
  // validation, which answers it with its usual error.
  if (typeof value !== "string") return;
  const violation = passwordPolicyViolation(value);
  if (violation !== null) {
    throw new APIError("BAD_REQUEST", {
      code: PASSWORD_TOO_WEAK_CODE,
      message: violation,
    });
  }
});

export function passwordPolicyPlugin(): BetterAuthPlugin {
  return {
    id: PASSWORD_POLICY_PLUGIN_ID,
    hooks: {
      before: [
        {
          matcher: (ctx) => passwordFieldFor(ctx.path) !== undefined,
          handler: refuseWeakPassword,
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
