"use client";
// The sidebar's sections for the current URL, shared by the desktop rail, the
// phone drawer, <ShellMobileNav>, the command menu and the chrome's counts.
import { usePathname } from "next/navigation";
import { type NavSection, parseShellPath, sidebarSections } from "./nav";
import type { ShellData } from "./shell-data";

/**
 * The workspace is the one in the URL or, on an organization page, the first
 * `shell.context` lists, so the workspace links always point somewhere the
 * viewer can open.
 */
export function useSidebarSections(data: ShellData): {
  sections: NavSection[];
  ws: string | null;
  pathname: string;
} {
  const pathname = usePathname();
  const { context } = data;
  const ws =
    parseShellPath(pathname).ws ??
    (context.ok ? (context.value.workspaces[0]?.slug ?? null) : null);
  return { sections: sidebarSections(data.org.slug, ws), ws, pathname };
}
