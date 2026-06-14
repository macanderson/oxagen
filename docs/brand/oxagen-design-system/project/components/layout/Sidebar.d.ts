import * as React from "react";

export interface SidebarItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
}
export interface SidebarGroup {
  label?: React.ReactNode;
  items: SidebarItem[];
}

/**
 * Vertical product navigation with grouped items and a gradient active-accent
 * bar that slides between selections. Slot `header` (brand lockup) and `footer`
 * (account row).
 *
 * @startingPoint section="Layout" subtitle="Vertical product sidebar nav" viewport="280x520"
 */
export interface SidebarProps extends React.HTMLAttributes<HTMLElement> {
  groups: SidebarGroup[];
  active?: string;
  onSelect?: (id: string) => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}

export function Sidebar(props: SidebarProps): React.ReactElement;
