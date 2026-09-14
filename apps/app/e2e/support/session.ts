import type { BrowserContext } from "@playwright/test";
import {
  FIXTURE_SESSION_COOKIE,
  FIXTURE_SESSION_VALUE,
  FIXTURE_USER,
} from "../../src/server/fixture-session";

export { FIXTURE_USER };

/**
 * Sign the browser in as the fixture operator. Honoured only by a dev server
 * started with MC_DATA=fixture (playwright.config.ts does this); a production
 * build ignores the cookie.
 */
export async function signInAsFixtureUser(
  context: BrowserContext,
  baseURL: string,
): Promise<void> {
  await context.addCookies([
    {
      name: FIXTURE_SESSION_COOKIE,
      value: FIXTURE_SESSION_VALUE,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
