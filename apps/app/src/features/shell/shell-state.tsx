"use client";
// The shell's client state: which overlay is open. One provider so the top bar
// button and ⌘K drive the same command menu, and the menu button and "More"
// the same phone drawer.
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Theme } from "./theme";
import { useTheme } from "./use-theme";

type ShellState = {
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
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

export function ShellStateProvider({ children }: { children: ReactNode }) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
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
      theme,
      setTheme,
    }),
    [commandOpen, drawerOpen, theme, setTheme],
  );
  return <ShellStateContext value={value}>{children}</ShellStateContext>;
}
