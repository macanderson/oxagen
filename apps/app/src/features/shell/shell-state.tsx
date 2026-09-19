"use client";
// The shell's client state: which overlay is open. One provider so the top bar
// button and ⌘K drive the same command menu, and the menu button and "More"
// the same phone drawer.
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

/** The Account dialog's tabs (mockup `accountTabs`); the onboarding demo tab is not a product tab. */
export const ACCOUNT_TABS = [
  "profile",
  "preferences",
  "security",
  "privacy",
] as const;
export type AccountTab = (typeof ACCOUNT_TABS)[number];

type ShellState = {
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  accountOpen: boolean;
  setAccountOpen: (open: boolean) => void;
  accountTab: AccountTab;
  setAccountTab: (tab: AccountTab) => void;
  /** Open the Account dialog on one of its tabs: the user menu's deep links. */
  openAccount: (tab: AccountTab) => void;
  /**
   * The avatar editor is its own dialog (mockup `avatarDlg`), opened from the
   * Profile tab in place of the Account dialog and returning to it on save or
   * cancel, so the two are never stacked.
   */
  avatarOpen: boolean;
  setAvatarOpen: (open: boolean) => void;
  workspaceSettingsOpen: boolean;
  setWorkspaceSettingsOpen: (open: boolean) => void;
  assistantOpen: boolean;
  setAssistantOpen: (open: boolean) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /**
   * True while a recovery-code rotation is in flight or a returned set is
   * unsaved. It lives here rather than in the Account dialog because the thing
   * that has to respect it is Sign out, which is in the user menu: a client
   * transition to `/login` leaves the shell layout, unmounts the dialog, and
   * takes the only plaintext copy of the codes with it. `beforeunload` does
   * not fire for a Next.js client transition, so the page-level guard cannot
   * see that exit at all.
   */
  codesAtStake: boolean;
  setCodesAtStake: (atStake: boolean) => void;
};

const ShellStateContext = createContext<ShellState | null>(null);

export function useShellState(): ShellState {
  const state = use(ShellStateContext);
  if (state === null)
    throw new Error("useShellState must be used inside <ShellStateProvider>");
  return state;
}

/** ⌘K on macOS, Ctrl+K elsewhere. */
function isCommandShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  return (
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    !e.shiftKey &&
    e.key.toLowerCase() === "k"
  );
}

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountTab, setAccountTab] = useState<AccountTab>("profile");
  const [avatarOpenRaw, setAvatarOpenRaw] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);

  const openAccount = useCallback((tab: AccountTab) => {
    setAccountTab(tab);
    setAvatarOpenRaw(false);
    setAccountOpen(true);
  }, []);

  const setAvatarOpen = useCallback((open: boolean) => {
    setAvatarOpenRaw(open);
    setAccountOpen(!open);
    if (!open) setAccountTab("profile");
  }, []);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [codesAtStake, setCodesAtStake] = useState(false);
  const { theme, setTheme } = useTheme();

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
      commandOpen,
      setCommandOpen,
      drawerOpen,
      setDrawerOpen,
      accountOpen,
      setAccountOpen,
      accountTab,
      setAccountTab,
      openAccount,
      avatarOpen: avatarOpenRaw,
      setAvatarOpen,
      workspaceSettingsOpen,
      setWorkspaceSettingsOpen,
      assistantOpen,
      setAssistantOpen,
      theme,
      setTheme,
      codesAtStake,
      setCodesAtStake,
    }),
    [
      commandOpen,
      drawerOpen,
      accountOpen,
      accountTab,
      openAccount,
      avatarOpenRaw,
      setAvatarOpen,
      workspaceSettingsOpen,
      assistantOpen,
      theme,
      setTheme,
      codesAtStake,
    ],
  );
  return <ShellStateContext value={value}>{children}</ShellStateContext>;
}
