"use client";
// A dialog (ARCHITECTURE.md §1.2, the phone shell): a centred modal on a wide
// screen and, below the md breakpoint, a sheet risen from the bottom edge with
// a drag handle, over a scrim, closed by a full-width footer button
// (src/ui/phone.css keys on the data attributes set here).
import { Dialog } from "@base-ui/react/dialog";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { buttonSecondary } from "@/ui/control-styles";

/** The drag handle a bottom sheet shows above its content; hidden on a wide screen. */
export function SheetHandle() {
  return (
    <span
      aria-hidden="true"
      data-sheet-handle=""
      className="mx-auto mt-2 block h-1 w-9 flex-none rounded-sm bg-border md:hidden"
    />
  );
}

export function SheetDialog({
  open,
  onOpenChange,
  title,
  testId,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  testId: string;
  children: ReactNode;
}) {
  const t = useTranslations("ui.dialog");
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          data-scrim=""
          className="fixed inset-0 z-50 bg-overlay-scrim"
        />
        <Dialog.Popup
          data-sheet=""
          data-testid={testId}
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[76dvh] w-[calc(100%-1.5rem)] max-w-md -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-dialog-border bg-dialog-bg text-dialog-fg shadow-2xl"
        >
          <SheetHandle />
          <Dialog.Title className="px-4 pb-2 pt-4 text-base font-semibold">
            {title}
          </Dialog.Title>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {children}
          </div>
          <div
            data-sheet-footer=""
            className="flex justify-end gap-2 border-t border-border px-4 py-3"
          >
            <Dialog.Close data-touch-target="" className={buttonSecondary}>
              {t("close")}
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
