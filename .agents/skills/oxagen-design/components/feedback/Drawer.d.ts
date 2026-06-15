import * as React from "react";

/**
 * Edge-anchored sliding drawer with scrim and spring slide. `side` = the edge
 * it slides from. Controlled via `open` / `onClose`.
 *
 * @startingPoint section="Feedback" subtitle="Sliding edge drawer with scrim" viewport="700x320"
 */
export interface DrawerProps {
  open: boolean;
  onClose?: () => void;
  side?: "right" | "left" | "bottom";
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** Width (right/left) or height (bottom) in px. */
  size?: number;
}

export function Drawer(props: DrawerProps): React.ReactElement;
