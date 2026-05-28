import type { BrowserContext } from "@playwright/test";

// Programmatic login for E2E: injects a Better Auth session cookie that
// matches the `auth.sessions` row created by `setupAgentRuntimeFixture`.
// We sign nothing here — Better Auth in this app trusts the `id` lookup —
// so we just set the cookie value to the session token the fixture wrote.
export async function loginAs(
  context: BrowserContext,
  sessionToken: string,
  baseUrl: string = "http://localhost:3000",
): Promise<void> {
  const url = new URL(baseUrl);
  await context.addCookies([
    {
      name: "better-auth.session_token",
      value: sessionToken,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 60 * 60,
    },
  ]);
}
