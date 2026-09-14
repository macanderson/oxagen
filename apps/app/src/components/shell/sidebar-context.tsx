"use client";
/**
 * SidebarContext — collapse state for the floating left-nav shell.
 *
 * The shell sidebar collapses to an icon rail and back. State is persisted to
 * localStorage so it survives navigations and reloads. Mobile uses a separate
 * `openMobile` flag (the sidebar slides in as an overlay below `md`).
 *
 * Stock surfaces only — no glass. The provider holds no styling; it is pure
 * state shared by ShellFrame (the floating frame) and the Sidebar.
 */

import * as React from "react";

const STORAGE_KEY = "oxagen.sidebar.collapsed";
// Same-tab writes don't fire the `storage` event (that only fires in OTHER
// tabs), so we broadcast this custom event to notify the in-tab store.
const COLLAPSE_EVENT = "oxagen:sidebar-collapsed";

interface SidebarContextValue {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggle: () => void;
  openMobile: boolean;
  setOpenMobile: (next: boolean) => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

/** Read the persisted collapse flag; defaults to expanded if storage is unavailable. */
function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Subscribe to cross-tab (`storage`) and same-tab (`COLLAPSE_EVENT`) changes. */
function subscribeCollapsed(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(COLLAPSE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(COLLAPSE_EVENT, onChange);
  };
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [openMobile, setOpenMobile] = React.useState(false);

  // useSyncExternalStore hydrates from localStorage without a setState-in-effect
  // and without a hydration mismatch: the server snapshot is always `false`
  // (expanded), and the client snapshot reads the persisted value.
  const collapsed = React.useSyncExternalStore(
    subscribeCollapsed,
    readCollapsed,
    () => false,
  );

  const setCollapsed = React.useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      // Non-fatal — without persistence the flag resets next load.
    }
    window.dispatchEvent(new Event(COLLAPSE_EVENT));
  }, []);

  const toggle = React.useCallback(
    () => setCollapsed(!collapsed),
    [collapsed, setCollapsed],
  );

  const value = React.useMemo<SidebarContextValue>(
    () => ({ collapsed, setCollapsed, toggle, openMobile, setOpenMobile }),
    [collapsed, setCollapsed, toggle, openMobile],
  );

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarContextValue {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within a SidebarProvider");
  return ctx;
}
