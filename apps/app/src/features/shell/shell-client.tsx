"use client";
// The client shell: every interactive piece of the chrome under one state
// provider. It renders grid items (rail, top bar) plus fixed and portalled
// overlays, so the layout places it beside the page without a wrapper.
import { useSearchParams } from "next/navigation";
import { AccountDialog } from "./account-dialog";
import { AssistantFlyout } from "./assistant-flyout";
import { CommandMenu } from "./command-menu";
import { NavDrawer, ShellMobileNav } from "./mobile-nav";
import type { ShellData } from "./shell-data";
import { parseAccountTab, ShellStateProvider } from "./shell-state";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function ShellClient({ data }: { data: ShellData }) {
  // `?dialog=account&tab=security` opens the Account dialog: the landing spot
  // for the retired /account pages (plan §4.11 redirects them here).
  const search = useSearchParams();
  const initialAccountTab =
    search.get("dialog") === "account"
      ? parseAccountTab(search.get("tab"))
      : null;
  return (
    <ShellStateProvider initialAccountTab={initialAccountTab}>
      <Sidebar data={data} />
      <Topbar data={data} />
      <AssistantFlyout engine={data.engine} />
      <ShellMobileNav data={data} />
      <NavDrawer data={data} />
      <CommandMenu data={data} />
      <AccountDialog data={data} />
    </ShellStateProvider>
  );
}
