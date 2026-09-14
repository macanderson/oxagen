import type { BrowserContext } from "@playwright/test";

/**
 * The page-state switch for fixture-mode e2e (plan §4.12). The fixture data
 * source reads this cookie in dev/test only and returns the matching Read<T>
 * arm, so one spec can walk every state of a page. `not_backed` returns the
 * milestone and gap the live source would answer for that read
 * (src/data/backing.ts), so e2e sees what production shows before a store lands.
 *
 * The value is either one state for every page (`denied`) or per page
 * (`fleet:denied,run:empty`); `assistant:down` puts the assistant engine down.
 */
export const MC_STATE_COOKIE = "mc_state";

export const PAGE_STATES = [
  "loaded",
  "empty",
  "loading",
  "error",
  "denied",
  "not_backed",
] as const;
export type PageStateName = (typeof PAGE_STATES)[number];

export async function setPageState(
  context: BrowserContext,
  baseURL: string,
  state: PageStateName,
  /** Scope the state to one page key (src/data/page-states.ts); every page when omitted. */
  page?: string,
): Promise<void> {
  const value = page === undefined ? state : `${page}:${state}`;
  await context.addCookies([
    { name: MC_STATE_COOKIE, value: encodeURIComponent(value), url: baseURL },
  ]);
}

export async function clearPageState(context: BrowserContext): Promise<void> {
  await context.clearCookies({ name: MC_STATE_COOKIE });
}
