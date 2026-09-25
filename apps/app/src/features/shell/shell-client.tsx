"use client";
// The client shell: every interactive piece of the chrome under one state
// provider. It renders grid items (rail, top bar) plus fixed and portalled
// overlays, so the layout places it beside the page without a wrapper, and it
// labels the page's list tables for the phone's card layout.
import type { ReactNode } from "react";
import { AccountDialog } from "./account-dialog";
import { ApprovalsDrawer } from "./approvals-drawer";
import { AssistantFlyout } from "./assistant-flyout";
import { AvatarDialog } from "./avatar-dialog";
import { useCardTables } from "./card-tables";
import { CommandMenu } from "./command-menu";
import { NavDrawer, ShellMobileNav } from "./mobile-nav";
import { NotificationsDialog } from "./notifications-dialog";
import type { ShellData } from "./shell-data";
import { ShellStateProvider } from "./shell-state";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

export function ShellClient({
  data,
  cards = {},
}: {
  data: ShellData;
  /** The approval card per parked call, rendered on the server (shell-chrome.tsx). */
  cards?: Readonly<Record<string, ReactNode>>;
}) {
  useCardTables();
  return (
    <ShellStateProvider>
      <Sidebar data={data} />
      <Topbar data={data} />
      <ShellMobileNav data={data} />
      <NavDrawer data={data} />
      <CommandMenu data={data} />
      <AccountDialog data={data} />
      <AvatarDialog data={data} />
      <AssistantFlyout enterToSubmit={data.viewer.enterToSubmit} />
      <NotificationsDialog data={data} />
      <ApprovalsDrawer data={data} cards={cards} />
    </ShellStateProvider>
  );
}
