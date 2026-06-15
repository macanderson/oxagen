import * as React from "react";

/**
 * Centered modal dialog with a blurred scrim, spring entrance, and Esc-to-close.
 * Controlled via `open` / `onClose`.
 *
 * @startingPoint section="Feedback" subtitle="Animated modal dialog with scrim" viewport="700x320"
 */
export interface DialogProps {
  open: boolean;
  onClose?: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Footer node, usually the action buttons. */
  footer?: React.ReactNode;
  width?: number;
}

export function Dialog(props: DialogProps): React.ReactElement;
