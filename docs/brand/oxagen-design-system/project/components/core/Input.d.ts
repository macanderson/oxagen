import * as React from "react";

/**
 * Single-line text input. Dark-first surface with a violet focus glow. Pass a
 * `startIcon` for search/email affordances; set `invalid` to show the error ring.
 */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  size?: "sm" | "md" | "lg";
  invalid?: boolean;
  startIcon?: React.ReactNode;
}

export function Input(props: InputProps): React.ReactElement;
