import * as React from "react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "destructive"
  | "gradient"
  | "link";

export type ButtonSize = "sm" | "md" | "lg";

/**
 * Oxagen button. Use `primary` for the main action, `gradient` for the single
 * hero call-to-action on a surface, `secondary`/`outline`/`ghost` for everything
 * else. Compact density — `md` is 36px tall.
 *
 * @startingPoint section="Core" subtitle="Jewel-tone button with gradient hero variant" viewport="700x120"
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. Default "primary". */
  variant?: ButtonVariant;
  /** Density. Default "md". */
  size?: ButtonSize;
  /** Render a square icon-only button. */
  iconOnly?: boolean;
  /** Leading icon node (e.g. a Lucide SVG). */
  startIcon?: React.ReactNode;
  /** Trailing icon node. */
  endIcon?: React.ReactNode;
  disabled?: boolean;
}

export function Button(props: ButtonProps): React.ReactElement;
