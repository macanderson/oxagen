"use client";
// A toggle whose state lives in the URL: the Labels / API names switch and the
// category chips. It is a button with `aria-pressed`, because it toggles a
// view rather than going somewhere, and pressing it navigates to the URL that
// carries the new state, so a reload or a shared link keeps it. The caller
// names that URL: a pressed chip's is the one that clears it.
import type { ComponentProps, ReactNode } from "react";
import type { SafePath } from "@/shared/safe-path";
import { Button } from "@/ui/button";
import { useNavigate } from "@/ui/navigation";

type ButtonProps = ComponentProps<typeof Button>;

export function ToggleLink({
  to,
  pressed,
  variant = "ghost",
  size = "xs",
  className,
  children,
  ...data
}: {
  to: SafePath;
  pressed: boolean;
  /** A segmented choice or a chip is `ghost`, the kit's no-fill button. */
  variant?: ButtonProps["variant"];
  /** `xs` sets the least height, so a caller's `min-h-*` decides it. */
  size?: ButtonProps["size"];
  /** Layout and `aria-pressed:` state classes the variant does not set. */
  className?: string;
  children: ReactNode;
} & { [key: `data-${string}`]: string }) {
  const navigate = useNavigate();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-pressed={pressed}
      className={className}
      onClick={() => {
        navigate.push(to);
      }}
      {...data}
    >
      {children}
    </Button>
  );
}
