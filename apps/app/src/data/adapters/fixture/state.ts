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
//
// Two finer shell switches walk one read each without touching the rest of the
// chrome (plan W9 and the notification states):
//   mc_shell_engine=down                          the assistant engine is down
//   mc_shell_notifications=empty|error|not_backed only the notifications read
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

/** A cookie on the current request; undefined outside a request (build, cache scope). */
async function readCookie(name: string): Promise<string | undefined> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(name)?.value;
  } catch {
    // No request in scope (prerender or a unit test): no state switch applies.
    return undefined;
  }
}

/** The `mc_state` cookie on the current request. */
export function readStateCookie(): Promise<string | undefined> {
  return readCookie(MC_STATE_COOKIE);
}

export const SHELL_ENGINE_COOKIE = "mc_shell_engine";
export const SHELL_NOTIFICATIONS_COOKIE = "mc_shell_notifications";

export type ShellSwitches = {
  engine: "up" | "down";
  /** `loaded` defers to `mc_state`'s shell entry. */
  notifications: "loaded" | "empty" | "error" | "not_backed";
};

export const DEFAULT_SHELL_SWITCHES: ShellSwitches = {
  engine: "up",
  notifications: "loaded",
};

/** Read the shell switches from cookie values. Unknown values fall back to the defaults. */
export function parseShellSwitches(cookie: {
  engine?: string | undefined;
  notifications?: string | undefined;
}): ShellSwitches {
  const { notifications } = cookie;
  return {
    engine: cookie.engine === "down" ? "down" : "up",
    notifications:
      notifications === "empty" ||
      notifications === "error" ||
      notifications === "not_backed"
        ? notifications
        : "loaded",
  };
}

/** The shell switches on the current request. */
export async function readShellSwitchCookies(): Promise<ShellSwitches> {
  const [engine, notifications] = await Promise.all([
    readCookie(SHELL_ENGINE_COOKIE),
    readCookie(SHELL_NOTIFICATIONS_COOKIE),
  ]);
  return parseShellSwitches({ engine, notifications });
}
