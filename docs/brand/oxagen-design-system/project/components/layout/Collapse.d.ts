import * as React from "react";

/**
 * Single expandable disclosure row — rotating chevron + height-animated body.
 * Controlled via `open`/`onToggle` or uncontrolled via `defaultOpen`.
 *
 * @startingPoint section="Layout" subtitle="Animated collapse / disclosure" viewport="700x140"
 */
export interface CollapseProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Collapse(props: CollapseProps): React.ReactElement;
