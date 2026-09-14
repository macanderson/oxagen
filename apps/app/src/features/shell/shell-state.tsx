"use client";
// The shell's client state: which overlay is open. One provider so the sidebar
// launcher, the top bar button and ⌘K all drive the same assistant flyout,
// command menu, Account dialog and phone drawer.
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Theme } from "./theme";
import { useTheme } from "./use-theme";

export type AccountTab = "profile" | "preferences" | "security" | "privacy";
export const ACCOUNT_TABS: readonly AccountTab[] = [
  "profile",
  "preferences",
  "security",
  "privacy",
];

export function parseAccountTab(value: string | null | undefined): AccountTab {
  return ACCOUNT_TABS.find((t) => t === value) ?? "profile";
}

type ShellState = {
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  toggleAssistant: () => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  /** The open Account tab, or null when the dialog is closed. */
  accountTab: AccountTab | null;
  openAccount: (tab: AccountTab) => void;
  setAccountTab: (tab: AccountTab | null) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ShellStateContext = createContext<ShellState | null>(null);

export function useShellState(): ShellState {
  const state = use(ShellStateContext);
  if (state === null)
    throw new Error("useShellState must be used inside <ShellStateProvider>");
  return state;
}

/** ⌘K on macOS, Ctrl+K elsewhere. */
export function isCommandShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  return (
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    !e.shiftKey &&
    e.key.toLowerCase() === "k"
  );
}

export function ShellStateProvider({
  children,
  initialAccountTab = null,
}: {
  children: ReactNode;
  initialAccountTab?: AccountTab | null;
}) {
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [accountTab, setAccountTab] = useState<AccountTab | null>(
    initialAccountTab,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { theme, setTheme } = useTheme();

  const toggleAssistant = useCallback(() => {
    setAssistantOpen((open) => !open);
    // On a phone the launcher lives in the modal drawer; the flyout covers the column instead.
    setDrawerOpen(false);
  }, []);
  const openAccount = useCallback((tab: AccountTab) => {
    setAccountTab(tab);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isCommandShortcut(e)) {
        e.preventDefault();
        setCommandOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const value = useMemo<ShellState>(
    () => ({
      assistantOpen,
      setAssistantOpen,
      toggleAssistant,
      commandOpen,
      setCommandOpen,
      accountTab,
      openAccount,
      setAccountTab,
      drawerOpen,
      setDrawerOpen,
      theme,
      setTheme,
    }),
    [
      assistantOpen,
      toggleAssistant,
      commandOpen,
      accountTab,
      openAccount,
      drawerOpen,
      theme,
      setTheme,
    ],
  );
  return <ShellStateContext value={value}>{children}</ShellStateContext>;
}
