"use client";
// A link drawn as a toggle chip (roadmap pages/steering.md, the shelf row and
// the Proposals segments): `role="button"` with `aria-pressed`, as the design
// marks them, and still a link, so the choice has an address and the back
// button walks it. A button activates on Space as well as Enter, and an anchor
// only on Enter, so Space is handled here: without it a keyboard user who
// trusts the role would press Space and get a scrolled page.
import type { ComponentProps, KeyboardEvent } from "react";
import { SafeLink } from "./navigation";

export function PressLink({
  pressed,
  onKeyDown,
  ...props
}: Omit<ComponentProps<typeof SafeLink>, "role" | "aria-pressed"> & {
  /** Whether this chip is the one in force. */
  pressed: boolean;
}) {
  return (
    <SafeLink
      {...props}
      role="button"
      aria-pressed={pressed}
      onKeyDown={(event: KeyboardEvent<HTMLAnchorElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.key !== " ") return;
        event.preventDefault();
        event.currentTarget.click();
      }}
    />
  );
}
