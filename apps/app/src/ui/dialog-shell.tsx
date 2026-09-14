"use client";

// The dialog frame the Mission Control primitives share: Base UI's Dialog from
// the app's own @base-ui/react, dressed in the same house dialog tokens as
// @oxagen/ui's Dialog. It is built here rather than imported because
// @oxagen/ui pins react 19.2.6 as its peer while the app runs 19.3.0; under
// Vite (Vitest, Storybook) that resolves two Reacts and Base UI's hooks crash.
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

export const DialogRoot = Dialog.Root;
export const DialogTrigger = Dialog.Trigger;
export const DialogClose = Dialog.Close;

export type DialogPanelProps = {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Pick<ComponentProps<typeof Dialog.Popup>, "initialFocus">;

export function DialogPanel({
  title,
  description,
  children,
  className,
  initialFocus,
}: DialogPanelProps) {
  const t = useTranslations("ui.dialog");
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay-scrim transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
      <Dialog.Popup
        initialFocus={initialFocus}
        className={cx(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-dialog-border bg-dialog-bg p-6 text-dialog-fg",
          "transition-[opacity,scale] data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0",
          className,
        )}
      >
        <div className="flex flex-col gap-1.5 pr-8">
          <Dialog.Title className="text-lg font-semibold leading-tight">
            {title}
          </Dialog.Title>
          {description ? (
            <Dialog.Description className="text-sm text-muted-foreground">
              {description}
            </Dialog.Description>
          ) : null}
        </div>
        {children}
        <Dialog.Close
          aria-label={t("close")}
          className="absolute right-4 top-4 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden focusable={false} className="size-4" />
        </Dialog.Close>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}
