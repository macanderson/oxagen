// Dev/e2e switches for the shell's fixture reads, so one spec can walk the
// assistant's engine-down state (plan W9) and the notification states without a
// real engine. Honoured only in fixture mode (see `shellSource`); a production
// build never reads them.
//
// These are separate from the page-level `mc_state` cookie on purpose: the
// shell wraps every page, so a page's error state must not break the chrome.

export const SHELL_ENGINE_COOKIE = "mc_shell_engine";
export const SHELL_NOTIFICATIONS_COOKIE = "mc_shell_notifications";

export type EngineSwitch = "up" | "down";
export type NotificationsSwitch = "loaded" | "empty" | "error" | "not_backed";

export type ShellSwitches = {
  engine: EngineSwitch;
  notifications: NotificationsSwitch;
};

export const DEFAULT_SWITCHES: ShellSwitches = {
  engine: "up",
  notifications: "loaded",
};

/** Read the switches from cookie values. Unknown values fall back to the defaults. */
export function parseShellSwitches(cookie: {
  engine?: string | undefined;
  notifications?: string | undefined;
}): ShellSwitches {
  const engine: EngineSwitch = cookie.engine === "down" ? "down" : "up";
  const notifications: NotificationsSwitch =
    cookie.notifications === "empty" ||
    cookie.notifications === "error" ||
    cookie.notifications === "not_backed"
      ? cookie.notifications
      : "loaded";
  return { engine, notifications };
}
