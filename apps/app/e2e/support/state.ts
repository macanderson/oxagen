import type { BrowserContext } from "@playwright/test";

/**
 * The page-state switch for fixture-mode e2e (plan §4.12). The fixture data
 * source reads this cookie in dev/test only and returns the matching Read<T>
 * arm, so one spec can walk every state of a page.
 */
export const MC_STATE_COOKIE = "mc_state";

export const PAGE_STATES = [
  "loaded",
  "empty",
  "loading",
  "error",
  "denied",
] as const;
export type PageStateName = (typeof PAGE_STATES)[number];

export async function setPageState(
  context: BrowserContext,
  baseURL: string,
  state: PageStateName,
): Promise<void> {
  await context.addCookies([
    { name: MC_STATE_COOKIE, value: state, url: baseURL },
  ]);
}

export async function clearPageState(context: BrowserContext): Promise<void> {
  await context.clearCookies({ name: MC_STATE_COOKIE });
}
