import * as React from "react";

/**
 * Titled surface container with header (eyebrow + title + actions), body and
 * optional footer. The workhorse block for settings/detail/dashboard layouts.
 * `inset` removes body padding for flush content like tables.
 *
 * @startingPoint section="Layout" subtitle="Titled panel container" viewport="700x260"
 */
export interface PanelProps extends React.HTMLAttributes<HTMLElement> {
  title?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  inset?: boolean;
}

export function Panel(props: PanelProps): React.ReactElement;
