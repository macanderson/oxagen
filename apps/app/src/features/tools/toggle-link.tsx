"use client";
// A toggle whose state lives in the URL: the Labels / API names switch and the
// category chips. It is a button with `aria-pressed`, because it toggles a
// view rather than going somewhere, and pressing it navigates to the URL that
// carries the new state, so a reload or a shared link keeps it. The caller
// names that URL: a pressed chip's is the one that clears it.
import type { ReactNode } from "react";
import type { SafePath } from "@/shared/safe-path";
import { useNavigate } from "@/ui/navigation";

export function ToggleLink({
  to,
  pressed,
  className,
  children,
  ...data
}: {
  to: SafePath;
  pressed: boolean;
  className: string;
  children: ReactNode;
} & { [key: `data-${string}`]: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={className}
      onClick={() => {
        navigate.push(to);
      }}
      {...data}
    >
      {children}
    </button>
  );
}
