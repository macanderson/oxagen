"use client";
// The client shell: every interactive piece of the chrome under one state
// provider. It renders grid items (rail, top bar) plus fixed and portalled
// overlays, so the layout places it beside the page without a wrapper.
import { CommandMenu } from "./command-menu";
import { NavDrawer, ShellMobileNav } from "./mobile-nav";
import type { ShellData } from "./shell-data";
import { ShellStateProvider } from "./shell-state";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function ShellClient({ data }: { data: ShellData }) {
  return (
    <ShellStateProvider>
      <Sidebar data={data} />
      <Topbar data={data} />
      <ShellMobileNav data={data} />
      <NavDrawer data={data} />
      <CommandMenu data={data} />
    </ShellStateProvider>
  );
}
