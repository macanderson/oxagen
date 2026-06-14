import * as React from "react";

export type BadgeVariant =
  | "default"
  | "neutral"
  | "brand"
  | "cyan"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "risk-low"
  | "risk-medium"
  | "risk-high";

/**
 * Compact label / status pill. The `risk-*` variants back the agent tool-call
 * risk signal; `cyan` is the knowledge-graph accent; `mono` switches to Aeonik
 * Mono for IDs and codes.
 */
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  /** Use the mono face (for IDs, tokens, counts). */
  mono?: boolean;
  /** Show a leading status dot. */
  dot?: boolean;
}

export function Badge(props: BadgeProps): React.ReactElement;
