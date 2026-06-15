import * as React from "react";

export interface MainNavItem {
  id: string;
  label: React.ReactNode;
  href?: string;
}

/**
 * Horizontal top navigation bar with a blurred translucent background and a
 * sliding gradient underline that follows hover/active. For marketing/docs
 * surfaces (not used in the app shell, but part of the kit).
 *
 * @startingPoint section="Layout" subtitle="Horizontal top nav with sliding underline" viewport="900x80"
 */
export interface MainNavProps extends React.HTMLAttributes<HTMLElement> {
  brand?: React.ReactNode;
  items: MainNavItem[];
  active?: string;
  onSelect?: (id: string) => void;
  actions?: React.ReactNode;
  sticky?: boolean;
}

export function MainNav(props: MainNavProps): React.ReactElement;
