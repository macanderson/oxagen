"use client";
import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;
const DialogPortal = DialogPrimitive.Portal;

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Backdrop>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Backdrop
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-overlay-scrim transition-opacity duration-[var(--motion-overlay)] ease-[var(--ease-entry)] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

interface DialogPopupProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Popup> {
  /** Forwarded to Base UI `Dialog.Portal` (e.g. `keepMounted`, custom `container`). */
  portalProps?: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>;
}

const DialogPopup = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Popup>,
  DialogPopupProps
>(({ className, children, portalProps, ...props }, ref) => (
  <DialogPortal {...portalProps}>
    <DialogOverlay />
    <DialogPrimitive.Popup
      ref={ref}
      className={cn(
        // max-h + overflow-y-auto keep the popup within the viewport and let
        // over-tall content (e.g. the Stripe Payment Element) scroll internally
        // instead of clipping off the top and bottom edges. w-[calc(100%-2rem)]
        // keeps a floating rounded card on mobile, not an edge-to-edge sheet.
        "fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border border-dialog-border bg-dialog-bg p-6 text-dialog-fg",
        "transition-[opacity,transform,translate,scale] duration-[var(--motion-overlay)] ease-[var(--ease-entry)] data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Popup>
  </DialogPortal>
));
DialogPopup.displayName = "DialogPopup";

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className,
    )}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

/** coss ui body wrapper — sits between `DialogHeader` and `DialogFooter`. */
const DialogPanel = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-2", className)} {...props} />
);
DialogPanel.displayName = "DialogPanel";

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
