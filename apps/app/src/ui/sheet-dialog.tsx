"use client";
// A dialog (ARCHITECTURE.md §1.2, the phone shell): a centred modal on a wide
// screen and, below the md breakpoint, a sheet risen from the bottom edge with
// a drag handle, over a scrim, closed by a full-width footer button
// (src/ui/phone.css keys on the data attributes set here).
import { Dialog } from "@base-ui/react/dialog";
import { useTranslations } from "next-intl";
import { createContext, type ReactNode, use, useState } from "react";
import { createPortal } from "react-dom";
import { buttonSecondary } from "@/ui/control-styles";

const FooterSlotContext = createContext<HTMLElement | null>(null);

/**
 * A dialog's primary action, rendered from inside its body into the footer
 * beside Close, for a body whose tabs each own their submit button and its
 * pending state, which a static `footer` prop could not carry.
 */
export function SheetFooterAction({ children }: { children: ReactNode }) {
  const slot = use(FooterSlotContext);
  return slot ? createPortal(children, slot) : null;
}

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
  subtitle,
  tabs,
  footer,
  closeLabel,
  wide = false,
  headerClose = false,
  side = false,
  dismissible = true,
  testId,
  children,
}: {
  dismissible?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** A line under the title in the muted ink: the record the dialog is about. */
  subtitle?: string;
  /** A tab row that sits between the header and the body (the Account dialog). */
  tabs?: ReactNode;
  /** Actions drawn before the Close button; the primary action goes here. */
  footer?: ReactNode;
  /** What the dismiss button says when "Close" is not the word, such as "Cancel" beside a Save. */
  closeLabel?: string;
  /** The mockup's dialog width (600px) for editors that need two columns. */
  wide?: boolean;
  /**
   * The mockup's × in the header's corner (`.dlg-h .x`), beside the footer's
   * Close or Cancel, for a dialog whose design draws one.
   */
  headerClose?: boolean;
  /** Organization activity opens beside the page on desktop. */
  side?: boolean;
  testId: string;
  children: ReactNode;
}) {
  const t = useTranslations("ui.dialog");
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next || dismissible) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          data-scrim=""
          className="fixed inset-0 z-50 bg-overlay-scrim"
        />
        <Dialog.Popup
          data-sheet=""
          data-testid={testId}
          className={`fixed z-50 flex flex-col overflow-hidden border border-dialog-border bg-dialog-bg text-dialog-fg shadow-2xl ${side ? "inset-y-0 right-0 w-full max-w-lg" : `left-1/2 top-[12vh] max-h-[76dvh] w-[calc(100%-1.5rem)] -translate-x-1/2 rounded-xl ${wide ? "max-w-[600px]" : "max-w-md"}`}`}
        >
          <SheetHandle />
          <div
            className={`relative border-b border-border px-4 pt-4 ${tabs ? "pb-0" : "pb-3"} ${headerClose ? "pr-12" : ""}`}
          >
            {headerClose ? (
              <Dialog.Close
                disabled={!dismissible}
                aria-label={t("dismiss")}
                data-header-close=""
                className="absolute right-2.5 top-2.5 inline-flex size-8 max-md:size-11 items-center justify-center rounded-md text-lg leading-none text-muted-foreground hover:bg-hl hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span aria-hidden="true">×</span>
              </Dialog.Close>
            ) : null}
            <Dialog.Title className="text-base font-semibold">
              {title}
            </Dialog.Title>
            {subtitle ? (
              <Dialog.Description className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {subtitle}
              </Dialog.Description>
            ) : null}
          </div>
          {tabs ? <div className="px-4">{tabs}</div> : null}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
            <FooterSlotContext value={slot}>{children}</FooterSlotContext>
          </div>
          {/* Close first, the primary action last: the mockup's footer reads
              "Cancel · Save", and on a phone the row reverses so the primary
              sits under the thumb (src/ui/phone.css). */}
          <div
            data-sheet-footer=""
            className="flex flex-wrap justify-end gap-2 border-t border-border px-4 py-3"
          >
            <Dialog.Close
              disabled={!dismissible}
              data-touch-target=""
              className={buttonSecondary}
            >
              {closeLabel ?? t("close")}
            </Dialog.Close>
            {footer}
            <div
              ref={setSlot}
              data-footer-slot=""
              className="flex gap-2 empty:hidden"
            />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
