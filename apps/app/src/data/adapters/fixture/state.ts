// The `mc_state` switch (plan §4.12): in dev and e2e, one cookie makes the
// fixture adapter return a page's loading, empty, error, denied or not-backed
// state, so a spec can walk every state of a page against the same seed.
//
//   mc_state=error                  every page's reads fail with its §2.1 code
//   mc_state=fleet:denied,run:empty per page; a page entry beats the global one
//   mc_state=assistant:down         the assistant engine reports down (W9)
//
// The global form never applies to the shell, so a page's error state still
// renders inside working chrome; address it as `shell:<state>`.
import { isPageKey, type PageKey } from "@/data/page-states";
import { isFixtureMode } from "@/server/fixture-session";

export const MC_STATE_COOKIE = "mc_state";

export const READ_STATES = [
  "loaded",
  "empty",
  "loading",
  "error",
  "denied",
  "not_backed",
] as const;
export type ReadState = (typeof READ_STATES)[number];

export type StateSwitch = {
  all: ReadState | null;
  pages: Partial<Record<PageKey, ReadState>>;
  assistantDown: boolean;
};

export const NO_STATE_SWITCH: StateSwitch = {
  all: null,
  pages: {},
  assistantDown: false,
};

function isReadState(value: string): value is ReadState {
  return (READ_STATES as readonly string[]).includes(value);
}

/** Parse the cookie. Unknown pages and states are ignored, never guessed at. */
export function parseStateSwitch(value: string | undefined): StateSwitch {
  if (!value) return NO_STATE_SWITCH;
  const result: StateSwitch = { all: null, pages: {}, assistantDown: false };
  for (const token of decodeURIComponent(value).split(",")) {
    const [left = "", right] = token.trim().split(":");
    if (right === undefined) {
      if (isReadState(left)) result.all = left;
    } else if (left === "assistant") {
      if (right === "down") result.assistantDown = true;
    } else if (isPageKey(left) && isReadState(right)) {
      result.pages[left] = right;
    }
  }
  return result;
}

export function stateFor(state: StateSwitch, page: PageKey): ReadState {
  return state.pages[page] ?? (page === "shell" ? null : state.all) ?? "loaded";
}

/** Dev and test only: a production build, or the live data source, ignores the cookie. */
export function isStateSwitchHonoured(): boolean {
  return isFixtureMode();
}

/** The cookie on the current request; undefined outside a request (build, cache scope). */
export async function readStateCookie(): Promise<string | undefined> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(MC_STATE_COOKIE)?.value;
  } catch {
    // No request in scope (prerender or a unit test): no state switch applies.
    return undefined;
  }
}
