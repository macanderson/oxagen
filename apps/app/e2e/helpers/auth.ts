import type { BrowserContext } from "@playwright/test";
import { createHmac } from "node:crypto";

// Programmatic login for E2E: injects the Better Auth session cookie for the
// `auth.sessions` row created by `setupAgentRuntimeFixture`, without going
// through OAuth.
//
// Better Auth (via better-call) stores the session as a SIGNED cookie named
// `${cookiePrefix}.session_token` whose value is
//   `${token}.${base64(HMAC-SHA256(secret, token))}`
// (standard base64, 44-char signature ending in `=`). The app sets
// cookiePrefix "oxagen" and — under E2E (see playwright webServer env) —
// disables secure cookies, so the name is `oxagen.session_token` and the
// cookie is sent over http. We replicate the exact signing here so the raw
// session token the fixture wrote is accepted.

// Match @oxagen/config's normalizeEnv: strip one balanced surrounding
// double-quote pair so the secret equals what the running app validated.
function readSecret(): string {
  const raw = process.env.BETTER_AUTH_SECRET ?? "";
  return raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
}

function signCookieValue(value: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(value).digest("base64");
  return `${value}.${signature}`;
}

export async function loginAs(
  context: BrowserContext,
  sessionToken: string,
  baseUrl: string = "http://localhost:3000",
): Promise<void> {
  const url = new URL(baseUrl);
  await context.addCookies([
    {
      name: "oxagen.session_token",
      value: signCookieValue(sessionToken, readSecret()),
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 60 * 60,
    },
  ]);
}
