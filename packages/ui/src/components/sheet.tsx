"use client";
import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "../lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Backdrop>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Backdrop>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Backdrop
    ref={ref}
    className={cn(
      // Token-driven scrim (matches DialogOverlay) — never a raw palette color.
      "fixed inset-0 z-50 bg-overlay-scrim transition-opacity duration-300 ease-[var(--ease-entry)] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = "SheetOverlay";

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-[var(--ease-entry)] duration-300 data-[ending-style]:duration-200",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[starting-style]:-translate-y-full data-[ending-style]:-translate-y-full",
        bottom:
          "inset-x-0 bottom-0 border-t data-[starting-style]:translate-y-full data-[ending-style]:translate-y-full",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[starting-style]:-translate-x-full data-[ending-style]:-translate-x-full sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full sm:max-w-sm",
      },
    },
    defaultVariants: { side: "right" },
  },
);

interface SheetPopupProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Popup>,
    VariantProps<typeof sheetVariants> {
  /** Forwarded to Base UI `Dialog.Portal` (e.g. `keepMounted`, custom `container`). */
  portalProps?: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>;
}

const SheetPopup = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Popup>,
  SheetPopupProps
>(({ side = "right", className, children, portalProps, ...props }, ref) => (
  <SheetPortal {...portalProps}>
    <SheetOverlay />
    <DialogPrimitive.Popup
      ref={ref}
      className={cn(sheetVariants({ side }), className)}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Popup>
  </SheetPortal>
));
SheetPopup.displayName = "SheetPopup";

const SheetHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className,
    )}
    {...props}
  />
);
SheetHeader.displayName = "SheetHeader";

/** coss ui body wrapper — sits between `SheetHeader` and `SheetFooter`. */
const SheetPanel = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-1 flex-col gap-2 overflow-y-auto", className)}
    {...props}
  />
);
SheetPanel.displayName = "SheetPanel";

const SheetFooter = ({
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
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-foreground", className)}
    {...props}
  />
));
SheetTitle.displayName = "SheetTitle";

const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = "SheetDescription";

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetPopup,
  SheetHeader,
  SheetPanel,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
