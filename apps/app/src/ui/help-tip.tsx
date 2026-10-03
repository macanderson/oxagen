"use client";
// A field's help: a small gold "?" beside its label. Hovering it opens a short
// note, and pressing it (a click, a tap, Enter or Space) opens the same note,
// so the help reaches a touch screen and a keyboard too. The button wears the
// primary button's gold and ink, so it reads as part of the house set.
//
// The note is a Base UI popover, so Escape and a press outside close it, and
// focus goes back to the button.
import { Popover } from "@base-ui/react/popover";
import type { ReactNode } from "react";
import { menuSurface } from "./control-styles";

export function HelpTip({
  label,
  testId,
  children,
}: {
  /** The button's accessible name, such as "Help for Name". */
  label: string;
  testId?: string;
  /** The note: one or two sentences. */
  children: ReactNode;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger
        openOnHover
        delay={100}
        aria-label={label}
        data-testid={testId}
        className="grid size-4.5 flex-none place-items-center rounded-full bg-button-primary-bg text-xs font-semibold leading-none text-button-primary-fg hover:bg-button-primary-hover-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span aria-hidden="true">?</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          sideOffset={6}
          collisionPadding={12}
          className="isolate z-50"
        >
          <Popover.Popup
            data-testid={testId === undefined ? undefined : `${testId}-note`}
            className={`${menuSurface} max-w-72 px-3 py-2.5 text-sm leading-normal`}
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
