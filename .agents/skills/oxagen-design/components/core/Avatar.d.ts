import * as React from "react";

/** Circular avatar — image or initials on a deterministic jewel gradient. */
export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  src?: string;
  name?: string;
  size?: number;
  /** Force the brand cosmos gradient instead of the name-hashed one. */
  gradient?: boolean;
}

export function Avatar(props: AvatarProps): React.ReactElement;
