import type { BrowserContext } from "@playwright/test";
import { createHmac } from "node:crypto";

// Cookie-injection login for E2E. The fixture (agent-runtime-fixture.ts)
// seeds auth.users + auth.sessions directly — no credential (auth.accounts)
// row exists, so a real email+password sign-in is impossible for seeded
// users. Instead we sign the pre-seeded session token exactly the way
// Better Auth does and inject it as a cookie. Specs that need to prove the
// real typed-form login round trip use signUpFreshUser (helpers/signup.ts),
// which drives the actual /signup form and therefore has a real password.

// Better Auth stores the session-token cookie as a SIGNED value:
//   `${token}.${base64(HMAC-SHA256(token, BETTER_AUTH_SECRET))}`
// (see better-auth cookies → setSignedCookie → makeSignature). On every request
// it verifies that signature before the DB lookup, so injecting a bare token
// yields no session and the app bounces to /login. We replicate the signature
// with node:crypto — verified byte-for-byte against better-auth's makeSignature.
function signSessionToken(token: string): string {
  let secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "loginWithSession: BETTER_AUTH_SECRET is not set in the test process — cannot " +
        "sign the session cookie. playwright.config.ts loadEnvLocal() must populate it.",
    );
  }
  // Strip one balanced surrounding double-quote pair (matches the running app's
  // normalizeEnv and playwright.config.ts loadEnvLocal) so the signing secret is
  // byte-identical to the server's.
  if (secret.length >= 2 && secret.startsWith('"') && secret.endsWith('"')) {
    secret = secret.slice(1, -1);
  }
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return `${token}.${signature}`;
}

// Inject a pre-seeded session token directly as a cookie, bypassing the
// email/password flow. Use this when the fixture seeds auth.sessions but not
// auth.accounts (credential rows). The cookie prefix "oxagen" must match the
// cookiePrefix in packages/auth/src/auth.ts.
export async function loginWithSession(
  context: BrowserContext,
  sessionToken: string,
  baseUrl: string = "http://localhost:3000",
): Promise<void> {
  const url = new URL(baseUrl);
  await context.addCookies([
    {
      name: "oxagen.session_token",
      value: signSessionToken(sessionToken),
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
    },
  ]);
}
